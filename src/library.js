// Reads the audio files in your music folder and remembers their lengths.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFile } from 'music-metadata';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.webm']);
const RESCAN_EVERY_MS = 60_000;

export class Library {
  constructor(folder) {
    this.folder = path.resolve(folder);
    this.tracks = new Map(); // file path -> { id, file, title, duration, mtime }
    this.lastScan = 0;
  }

  async scan(force = false) {
    if (!force && Date.now() - this.lastScan < RESCAN_EVERY_MS) return;
    this.lastScan = Date.now();

    const found = new Set();
    for (const file of await listAudioFiles(this.folder)) {
      found.add(file);
      const { mtimeMs } = await stat(file);
      const known = this.tracks.get(file);
      if (known && known.mtime === mtimeMs) continue;

      try {
        const meta = await parseFile(file, { duration: true, skipCovers: true });
        const duration = meta.format.duration;
        if (!duration) throw new Error('unknown duration');
        const fallback = path.basename(file, path.extname(file));
        const title = meta.common.title
          ? [meta.common.artist, meta.common.title].filter(Boolean).join(' – ')
          : fallback;
        const id = createHash('sha1').update(file).digest('hex').slice(0, 12);
        this.tracks.set(file, { id, file, title, duration, mtime: mtimeMs });
      } catch (err) {
        console.warn(`Skipping ${file}: ${err.message}`);
      }
    }
    for (const file of this.tracks.keys()) if (!found.has(file)) this.tracks.delete(file);
  }

  /** Up to 25 tracks whose title or file name contains the query (for autocomplete). */
  search(query = '') {
    const q = query.toLowerCase();
    return [...this.tracks.values()]
      .filter((t) => t.title.toLowerCase().includes(q) || path.basename(t.file).toLowerCase().includes(q))
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, 25);
  }

  /** Autocomplete sends back the short id we gave each track (values max out at 100 chars). */
  get(id) {
    for (const track of this.tracks.values()) if (track.id === id) return track;
    return null;
  }
}

async function listAudioFiles(folder) {
  const out = [];
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) out.push(...(await listAudioFiles(full)));
    else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}
