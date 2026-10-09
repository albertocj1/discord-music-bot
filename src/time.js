// Helpers for turning "1:30" into seconds and drawing the fake slider.

/**
 * Parse "90", "1:30", "01:02:03" or "1m30s" into seconds.
 * Returns null if the text isn't a valid time.
 */
export function parseTime(input) {
  if (input == null) return null;
  const text = String(input).trim().toLowerCase();
  if (text === '') return null;

  // 1h2m3s / 2m30s / 45s
  const unit = text.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/);
  if (unit && (unit[1] || unit[2] || unit[3])) {
    return (+unit[1] || 0) * 3600 + (+unit[2] || 0) * 60 + (+unit[3] || 0);
  }

  // 90 / 1:30 / 1:02:03
  if (!/^\d+(?:\.\d+)?(?::\d{1,2}(?:\.\d+)?){0,2}$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.slice(1).some((p) => p >= 60)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** 83 -> "1:23", 3723 -> "1:02:03" */
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Text slider. The thick part is the chosen section, ● is where playback is.
 *   ──━━━━━●━━━━━──
 */
export function progressBar(position, duration, sectionStart = 0, sectionEnd = duration, width = 20) {
  if (!duration || duration <= 0) return '─'.repeat(width);
  const cell = (t) => Math.min(width - 1, Math.max(0, Math.round((t / duration) * (width - 1))));
  const knob = cell(position);
  const from = cell(sectionStart);
  const to = cell(sectionEnd);
  let bar = '';
  for (let i = 0; i < width; i++) {
    if (i === knob) bar += '●';
    else bar += i >= from && i <= to ? '━' : '─';
  }
  return bar;
}
