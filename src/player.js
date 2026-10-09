// One GuildPlayer per server: voice connection, queue, seeking and sections.
//
// How seeking works: ffmpeg decodes the file starting at the time we ask for
// (-ss) and stops at the end of the chosen section (-t). Seeking just starts a
// fresh ffmpeg at the new time and swaps it in. The bot's position is
// "where this ffmpeg started" + "how long Discord has been playing it".
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';

const FULL_SONG = () => ({ start: 0, end: null, loop: false });

export class GuildPlayer extends EventEmitter {
  constructor(guildId) {
    super();
    this.guildId = guildId;
    this.connection = null;
    this.queue = []; // [{ track, requestedBy }]
    this.current = null; // { track, requestedBy }
    this.section = FULL_SONG(); // end === null means "end of the song"
    this.offset = 0; // seconds into the song where the current ffmpeg started
    this.resource = null;
    this.ffmpeg = null;
    this.wantPaused = false;

    this.audio = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.audio.on(AudioPlayerStatus.Idle, (oldState) => this.#onIdle(oldState));
    // A seek while paused creates a new resource; keep it paused once it's ready.
    this.audio.on(AudioPlayerStatus.Playing, () => {
      if (this.wantPaused) this.audio.pause();
    });
    this.audio.on('error', (err) => console.error(`[player ${guildId}]`, err.message));
  }

  // ---- state -------------------------------------------------------------

  get channelId() {
    return this.connection?.joinConfig.channelId ?? null;
  }

  get paused() {
    return this.wantPaused;
  }

  get sectionEnd() {
    return this.section.end ?? this.current?.track.duration ?? 0;
  }

  get hasSection() {
    if (!this.current) return false;
    return this.section.start > 0 || this.sectionEnd < this.current.track.duration;
  }

  /** Current playback position in seconds. */
  get position() {
    if (!this.current) return 0;
    const played = this.resource ? this.resource.playbackDuration / 1000 : 0;
    return Math.min(this.offset + played, this.sectionEnd);
  }

  // ---- voice -------------------------------------------------------------

  async connect(voiceChannel) {
    const alive = this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed;
    if (alive && this.channelId === voiceChannel.id) return;
    if (alive) this.connection.destroy();

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    this.connection = connection;

    // Recover from short network blips; give up if we were actually kicked.
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (this.connection === connection) this.destroy();
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      if (this.connection === connection) this.destroy();
      throw new Error('Could not join the voice channel (check the bot has Connect and Speak permissions).');
    }
    connection.subscribe(this.audio);
  }

  // ---- queue -------------------------------------------------------------

  /** Returns 'playing' if it started right away, or the queue position. */
  enqueue(track, requestedBy) {
    const item = { track, requestedBy };
    if (!this.current) {
      this.#load(item);
      return 'playing';
    }
    this.queue.push(item);
    return this.queue.length;
  }

  skip() {
    this.section.loop = false;
    this.#next();
  }

  stop() {
    this.queue = [];
    this.current = null;
    this.resource = null;
    this.wantPaused = false;
    this.audio.stop(true);
    this.#killFfmpeg();
    this.emit('finished');
  }

  destroy() {
    this.stop();
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    this.connection = null;
    this.emit('destroyed');
  }

  // ---- the "slider" ------------------------------------------------------

  /** Jump to an absolute time (seconds). Clamped to the current section. */
  seek(seconds) {
    if (!this.current) return;
    const { start } = this.section;
    const end = this.sectionEnd;
    const target = Math.min(Math.max(seconds, start), Math.max(start, end - 1));
    this.#startAt(target);
  }

  /** Move forward/back by delta seconds (e.g. +15 / -15). */
  nudge(delta) {
    this.seek(this.position + delta);
  }

  togglePause() {
    if (!this.current) return;
    if (this.wantPaused) {
      this.wantPaused = false;
      this.audio.unpause();
    } else {
      this.wantPaused = true;
      this.audio.pause(); // if still buffering, the Playing listener pauses it
    }
  }

  /**
   * Only play start..end (seconds). end = null means the end of the song.
   * Throws a friendly Error if the times don't make sense.
   */
  setSection(start, end, loop = this.section.loop) {
    if (!this.current) throw new Error('Nothing is playing.');
    const { duration } = this.current.track;
    const realEnd = end ?? duration;
    if (start < 0 || start >= duration) throw new Error(`Start must be before the end of the song.`);
    if (realEnd > duration + 0.5) throw new Error(`End is past the end of the song.`);
    if (realEnd - start < 1) throw new Error('End must be at least 1 second after start.');

    this.section = { start, end: realEnd >= duration ? null : realEnd, loop };
    this.#startAt(start);
  }

  clearSection() {
    if (!this.current) return;
    const at = this.position;
    this.section = { ...FULL_SONG(), loop: this.section.loop };
    this.#startAt(at); // restart so ffmpeg no longer stops at the old end
  }

  toggleLoop() {
    this.section.loop = !this.section.loop;
  }

  // ---- internals ---------------------------------------------------------

  #load(item) {
    this.current = item;
    this.section = FULL_SONG();
    this.wantPaused = false;
    this.#startAt(0);
    this.emit('trackStart', item);
  }

  #next() {
    const next = this.queue.shift();
    if (next) this.#load(next);
    else this.stop();
  }

  #startAt(seconds) {
    const { track } = this.current;
    const length = Math.max(0.5, this.sectionEnd - seconds);

    const ffmpeg = spawn(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', seconds.toFixed(3), // fast seek in the input
        '-i', track.file,
        '-t', length.toFixed(3), // stop at the section end
        '-map', '0:a:0', '-vn',
        '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2',
        '-frame_duration', '20', '-application', 'audio',
        '-f', 'ogg', 'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    ffmpeg.stderr.on('data', (d) => console.error(`[ffmpeg] ${String(d).trim()}`));
    ffmpeg.on('error', (err) => console.error('[ffmpeg] failed to start:', err.message));
    ffmpeg.stdout.on('error', () => {}); // ignore EPIPE when we kill it on seek

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
    const previous = this.ffmpeg;
    this.ffmpeg = ffmpeg;
    this.resource = resource;
    this.offset = seconds;
    this.audio.play(resource); // swaps the old resource out without an Idle event
    previous?.kill('SIGKILL');
  }

  #killFfmpeg() {
    this.ffmpeg?.kill('SIGKILL');
    this.ffmpeg = null;
  }

  #onIdle(oldState) {
    // Ignore resources we already replaced (seeks) and manual stops.
    if (!this.current || oldState.resource !== this.resource) return;

    const playedMs = this.resource.playbackDuration;
    if (this.section.loop && playedMs > 500) {
      this.#startAt(this.section.start);
      this.emit('looped');
      return;
    }
    if (playedMs <= 500) console.warn(`[player ${this.guildId}] "${this.current.track.title}" ended instantly; skipping.`);
    this.#next();
  }
}
