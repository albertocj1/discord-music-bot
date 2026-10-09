// Slash command definitions (registered by deploy-commands.js).
import { InteractionContextType, SlashCommandBuilder } from 'discord.js';

const guildOnly = (builder) => builder.setContexts(InteractionContextType.Guild);

export const commands = [
  guildOnly(
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Play a song from the music folder (or add it to the queue)')
      .addStringOption((o) =>
        o.setName('song').setDescription('Start typing to search').setRequired(true).setAutocomplete(true),
      ),
  ),
  guildOnly(
    new SlashCommandBuilder()
      .setName('seek')
      .setDescription('Jump to a time in the current song')
      .addStringOption((o) => o.setName('time').setDescription('e.g. 1:30, 90 or 1m30s').setRequired(true)),
  ),
  guildOnly(
    new SlashCommandBuilder()
      .setName('section')
      .setDescription('Only play part of the current song')
      .addStringOption((o) => o.setName('start').setDescription('e.g. 0:45').setRequired(true))
      .addStringOption((o) => o.setName('end').setDescription('e.g. 2:10 (leave out for the end of the song)'))
      .addBooleanOption((o) => o.setName('loop').setDescription('Repeat the section')),
  ),
  guildOnly(new SlashCommandBuilder().setName('panel').setDescription('Show the player controls again')),
  guildOnly(new SlashCommandBuilder().setName('stop').setDescription('Stop, clear the queue and leave')),
];
