// Run once (and again whenever you change commands.js): npm run deploy
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Set DISCORD_TOKEN and CLIENT_ID in .env first.');
  process.exit(1);
}

const rest = new REST().setToken(DISCORD_TOKEN);
const body = commands.map((c) => c.toJSON());

// GUILD_ID = your test server: commands appear instantly.
// No GUILD_ID = every server the bot is in (can take a while to show up).
const route = GUILD_ID ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID) : Routes.applicationCommands(CLIENT_ID);

await rest.put(route, { body });
console.log(`Registered ${body.length} commands ${GUILD_ID ? `in server ${GUILD_ID}` : 'globally'}.`);
