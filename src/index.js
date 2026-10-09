// Entry point: npm start
import 'dotenv/config';
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { Library } from './library.js';
import { GuildPlayer } from './player.js';
import { ID, NUDGE_SECONDS, buildPanel, buildSectionForm, idlePanel } from './panel.js';
import { formatTime, parseTime } from './time.js';

if (process.argv.includes('--check')) {
  console.log(generateDependencyReport());
  process.exit(0);
}

const REFRESH_EVERY_MS = 10_000; // how often the progress bar redraws
const LEAVE_AFTER_MS = 60_000; // leave voice after this long with nothing playing

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const library = new Library(process.env.MUSIC_DIR || './music');

/** guildId -> { player, panel, ticker, leaveTimer } */
const sessions = new Map();

class UserError extends Error {}

// ---- sessions & the live panel ---------------------------------------------

function getSession(guildId) {
  let s = sessions.get(guildId);
  if (s) return s;

  const player = new GuildPlayer(guildId);
  s = { player, panel: null, ticker: null, leaveTimer: null };
  sessions.set(guildId, s);

  player.on('trackStart', () => {
    clearTimeout(s.leaveTimer);
    refreshPanel(s);
    startTicker(s);
  });
  player.on('looped', () => refreshPanel(s));
  player.on('finished', () => {
    stopTicker(s);
    refreshPanel(s);
    clearTimeout(s.leaveTimer);
    s.leaveTimer = setTimeout(() => {
      if (!player.current) player.destroy();
    }, LEAVE_AFTER_MS);
  });
  player.on('destroyed', () => {
    stopTicker(s);
    clearTimeout(s.leaveTimer);
    sessions.delete(guildId);
  });
  return s;
}

function startTicker(s) {
  if (s.ticker) return;
  s.ticker = setInterval(() => {
    if (s.player.current && !s.player.paused) refreshPanel(s);
  }, REFRESH_EVERY_MS);
}

function stopTicker(s) {
  clearInterval(s.ticker);
  s.ticker = null;
}

async function refreshPanel(s) {
  if (!s.panel) return;
  try {
    await s.panel.edit(buildPanel(s.player));
  } catch (err) {
    console.warn('Could not update the panel:', err.message);
    if (err.code === 10008) s.panel = null; // message was deleted
  }
}

/** Make `message` the live panel and strip the controls off the old one. */
function setPanel(s, message) {
  const old = s.panel;
  s.panel = message;
  if (old && old.id !== message.id) {
    old.edit(idlePanel('Controls moved to a newer message ↓')).catch(() => {});
  }
}

/** The user must be in a voice channel, and in the bot's one if it's busy. */
function requireListener(interaction, player) {
  const channel = interaction.member.voice.channel;
  if (!channel) throw new UserError('Join a voice channel first.');
  if (player.current && player.channelId && player.channelId !== channel.id) {
    throw new UserError(`I'm playing in <#${player.channelId}>. Join that channel to control me.`);
  }
  return channel;
}

function requirePlaying(guildId) {
  const s = sessions.get(guildId);
  if (!s?.player.current) throw new UserError('Nothing is playing right now.');
  return s;
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

// ---- interactions -----------------------------------------------------------

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await onAutocomplete(interaction);
    if (!interaction.inCachedGuild()) return;
    if (interaction.isChatInputCommand()) return await onCommand(interaction);
    if (interaction.isButton() || interaction.isStringSelectMenu()) return await onControl(interaction);
    if (interaction.isModalSubmit() && interaction.customId === ID.sectionForm) return await onSectionForm(interaction);
  } catch (err) {
    if (!(err instanceof UserError)) console.error(err);
    if (!interaction.isRepliable()) return;
    const msg = ephemeral(err instanceof UserError ? `⚠️ ${err.message}` : '⚠️ Something went wrong. Check the bot logs.');
    if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: msg.content }).catch(() => {});
    else if (interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

async function onAutocomplete(interaction) {
  library.scan().catch(console.error); // picks up new files in the background
  const query = interaction.options.getFocused();
  await interaction.respond(
    library.search(query).map((t) => ({ name: clip(`${t.title} · ${formatTime(t.duration)}`, 100), value: t.id })),
  );
}

async function onCommand(interaction) {
  switch (interaction.commandName) {
    case 'play': {
      const s = getSession(interaction.guildId);
      const channel = requireListener(interaction, s.player);
      const query = interaction.options.getString('song', true);
      const track = library.get(query) ?? library.search(query)[0];
      if (!track) throw new UserError(`No song matches "${query}". Put audio files in the music folder.`);

      await interaction.deferReply();
      try {
        await s.player.connect(channel);
      } catch (err) {
        throw new UserError(err.message);
      }

      if (!s.player.current) s.panel = null; // a fresh panel is posted below
      const result = s.player.enqueue(track, interaction.user.id);

      if (result === 'playing') {
        setPanel(s, await interaction.editReply(buildPanel(s.player)));
      } else {
        await interaction.editReply({ content: `➕ Queued **${track.title}** (#${result} in line)` });
        refreshPanel(s);
      }
      return;
    }

    case 'seek': {
      const s = requirePlaying(interaction.guildId);
      requireListener(interaction, s.player);
      const time = parseTime(interaction.options.getString('time', true));
      if (time == null) throw new UserError('I could not read that time. Try `1:30`, `90` or `1m30s`.');
      s.player.seek(time);
      await interaction.reply(ephemeral(`⏩ Jumped to **${formatTime(s.player.position)}**`));
      refreshPanel(s);
      return;
    }

    case 'section': {
      const s = requirePlaying(interaction.guildId);
      requireListener(interaction, s.player);
      const { start, end } = readSection(
        interaction.options.getString('start', true),
        interaction.options.getString('end') ?? '',
      );
      const loop = interaction.options.getBoolean('loop') ?? s.player.section.loop;
      applySection(s.player, start, end, loop);
      await interaction.reply(ephemeral(describeSection(s.player)));
      refreshPanel(s);
      return;
    }

    case 'panel': {
      const s = requirePlaying(interaction.guildId);
      const response = await interaction.reply({ ...buildPanel(s.player), withResponse: true });
      setPanel(s, response.resource.message);
      return;
    }

    case 'stop': {
      const s = sessions.get(interaction.guildId);
      if (s) {
        requireListener(interaction, s.player);
        s.player.destroy();
      }
      await interaction.reply({ content: '⏹ Stopped and left the voice channel.', allowedMentions: { parse: [] } });
      return;
    }
  }
}

async function onControl(interaction) {
  if (!interaction.customId.startsWith('mp:')) return;
  const s = sessions.get(interaction.guildId);
  if (!s?.player.current) {
    await interaction.update(idlePanel());
    return;
  }
  const { player } = s;
  requireListener(interaction, player);
  if (!s.panel) s.panel = interaction.message;

  switch (interaction.customId) {
    case ID.jump:
      player.seek(Number(interaction.values[0]));
      break;
    case ID.back:
      player.nudge(-NUDGE_SECONDS);
      break;
    case ID.forward:
      player.nudge(NUDGE_SECONDS);
      break;
    case ID.pause:
      player.togglePause();
      break;
    case ID.loop:
      player.toggleLoop();
      break;
    case ID.clear:
      player.clearSection();
      break;
    case ID.section:
      await interaction.showModal(buildSectionForm(player));
      return;
    case ID.skip:
      await interaction.deferUpdate(); // the trackStart event redraws the panel
      player.skip();
      return;
    case ID.stop:
      await interaction.deferUpdate(); // the finished event redraws the panel
      player.destroy();
      return;
    case ID.refresh:
      break;
  }
  await interaction.update(buildPanel(player));
}

async function onSectionForm(interaction) {
  const s = requirePlaying(interaction.guildId);
  requireListener(interaction, s.player);
  const { start, end } = readSection(
    interaction.fields.getTextInputValue('start'),
    interaction.fields.getTextInputValue('end'),
  );
  applySection(s.player, start, end, interaction.fields.getCheckbox('loop'));

  if (interaction.isFromMessage()) {
    await interaction.update(buildPanel(s.player));
  } else {
    await interaction.reply(ephemeral(describeSection(s.player)));
    refreshPanel(s);
  }
}

// ---- section helpers --------------------------------------------------------

function readSection(startText, endText) {
  const start = parseTime(startText);
  if (start == null) throw new UserError(`I could not read the start time "${startText}". Try \`1:30\` or \`90\`.`);
  const hasEnd = endText.trim() !== '';
  const end = hasEnd ? parseTime(endText) : null;
  if (hasEnd && end == null) throw new UserError(`I could not read the end time "${endText}". Try \`2:10\` or \`130\`.`);
  return { start, end };
}

function applySection(player, start, end, loop) {
  try {
    player.setSection(start, end, loop);
  } catch (err) {
    throw new UserError(err.message);
  }
}

function describeSection(player) {
  const { start, loop } = player.section;
  return `✂️ Playing **${formatTime(start)} → ${formatTime(player.sectionEnd)}**${loop ? ' on loop 🔁' : ''}`;
}

function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---- startup ----------------------------------------------------------------

client.once(Events.ClientReady, async (c) => {
  await library.scan(true);
  console.log(`Logged in as ${c.user.tag}. ${library.tracks.size} songs found in ${library.folder}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const { player } of sessions.values()) player.destroy();
    client.destroy();
    process.exit(0);
  });
}

if (!process.env.DISCORD_TOKEN) {
  console.error('Set DISCORD_TOKEN in .env (copy .env.example).');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
