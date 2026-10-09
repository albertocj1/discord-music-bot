// Builds the "Now playing" message and the section picker form.
//
// Discord has no slider component, so the panel imitates one:
//   - a text progress bar that the bot redraws every few seconds
//   - a "Jump to…" menu with 20 points spread across the song (scrubbing)
//   - ⏪ / ⏩ buttons for fine adjustment
//   - a form where you type the exact start and end of the part you want
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CheckboxBuilder,
  ContainerBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { formatTime, progressBar } from './time.js';

export const ID = {
  jump: 'mp:jump',
  back: 'mp:back',
  pause: 'mp:pause',
  forward: 'mp:forward',
  section: 'mp:section',
  stop: 'mp:stop',
  loop: 'mp:loop',
  clear: 'mp:clear',
  skip: 'mp:skip',
  refresh: 'mp:refresh',
  sectionForm: 'mp:section-form',
};

export const NUDGE_SECONDS = 15;
const JUMP_POINTS = 20;
const ACCENT = 0x5865f2;

const base = (container) => ({
  flags: MessageFlags.IsComponentsV2,
  components: [container],
  allowedMentions: { parse: [] }, // show @names without pinging anyone
});

/** The message for a player that has nothing loaded. */
export function idlePanel(note = 'Nothing playing. Use `/play` to start a song.') {
  const container = new ContainerBuilder()
    .setAccentColor(0x4f545c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ⏹ ${note}`));
  return base(container);
}

export function buildPanel(player) {
  if (!player.current) return idlePanel();

  const { track, requestedBy } = player.current;
  const duration = track.duration;
  const position = player.position;
  const { start, loop } = player.section;
  const end = player.sectionEnd;

  const status = player.paused ? '⏸ Paused' : '▶️ Playing';
  const header = [
    `### 🎵 ${escape(track.title)}`,
    `-# ${status} · requested by <@${requestedBy}>`,
  ].join('\n');

  const slider = [
    `\`${formatTime(position)}\` ${progressBar(position, duration, start, end)} \`${formatTime(duration)}\``,
    player.hasSection
      ? `✂️ Section **${formatTime(start)} → ${formatTime(end)}**${loop ? ' · 🔁 looping' : ''}`
      : loop
        ? '🔁 Looping the whole song'
        : null,
    player.queue.length
      ? `-# Up next: **${escape(player.queue[0].track.title)}**${player.queue.length > 1 ? ` (+${player.queue.length - 1} more)` : ''}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const jumpMenu = new StringSelectMenuBuilder()
    .setCustomId(ID.jump)
    .setPlaceholder(`🎚️ Jump to… (now at ${formatTime(position)})`)
    .addOptions(jumpOptions(start, end, player.hasSection));

  const controls = new ActionRowBuilder().addComponents(
    button(ID.back, `${NUDGE_SECONDS}s`, '⏪'),
    button(ID.pause, player.paused ? 'Resume' : 'Pause', player.paused ? '▶️' : '⏸', ButtonStyle.Primary),
    button(ID.forward, `${NUDGE_SECONDS}s`, '⏩'),
    button(ID.section, 'Section', '✂️'),
    button(ID.stop, 'Stop', '⏹', ButtonStyle.Danger),
  );

  const extras = new ActionRowBuilder().addComponents(
    button(ID.loop, loop ? 'Loop: on' : 'Loop: off', '🔁', loop ? ButtonStyle.Success : ButtonStyle.Secondary),
    button(ID.clear, 'Full song', '↩️').setDisabled(!player.hasSection),
    button(ID.skip, 'Skip', '⏭').setDisabled(player.queue.length === 0),
    button(ID.refresh, 'Refresh', '🔄'),
  );

  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(header), new TextDisplayBuilder().setContent(slider))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(jumpMenu), controls, extras);

  return base(container);
}

/** The form that opens when you press ✂️ Section. */
export function buildSectionForm(player) {
  const { track } = player.current;
  const startInput = new TextInputBuilder()
    .setCustomId('start')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 0:45')
    .setValue(formatTime(player.hasSection ? player.section.start : player.position))
    .setMaxLength(10)
    .setRequired(true);

  const endInput = new TextInputBuilder()
    .setCustomId('end')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(`e.g. 2:10 (blank = ${formatTime(track.duration)}, the end)`)
    .setValue(formatTime(player.sectionEnd))
    .setMaxLength(10)
    .setRequired(false);

  const loopBox = new CheckboxBuilder().setCustomId('loop').setDefault(player.section.loop);

  return new ModalBuilder()
    .setCustomId(ID.sectionForm)
    .setTitle('✂️ Play a section')
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**${escape(track.title)}** · ${formatTime(track.duration)} long\nType times like \`1:30\`, \`90\` or \`1m30s\`.`,
      ),
    )
    .addLabelComponents(
      new LabelBuilder().setLabel('Start').setDescription('Where the section begins').setTextInputComponent(startInput),
      new LabelBuilder().setLabel('End').setDescription('Where it stops').setTextInputComponent(endInput),
      new LabelBuilder()
        .setLabel('Loop this section')
        .setDescription('Repeat it until you turn loop off')
        .setCheckboxComponent(loopBox),
    );
}

function jumpOptions(start, end, inSection) {
  const span = end - start;
  const seen = new Set();
  const options = [];
  for (let i = 0; i < JUMP_POINTS; i++) {
    const t = Math.floor(start + (span * i) / JUMP_POINTS);
    if (seen.has(t)) continue;
    seen.add(t);
    const pct = Math.round((i / JUMP_POINTS) * 100);
    options.push({
      label: `${formatTime(t)}`,
      value: String(t),
      description: `${pct}% into the ${inSection ? 'section' : 'song'}`,
      emoji: { name: i === 0 ? '⏮' : '▸' },
    });
  }
  return options;
}

function button(customId, label, emoji, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji(emoji).setStyle(style);
}

function escape(text) {
  return text.replace(/([*_`~|\\>#])/g, '\\$1');
}
