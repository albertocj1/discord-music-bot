# Discord music bot with a timeline "slider"

Plays songs from a folder on your computer/server into a voice channel, with a control panel for picking exactly which part of the song plays.

Discord has no real slider component, so the panel builds one from the pieces it does have:

| Control | What it does |
| --- | --- |
| Progress bar `1:23 ──━━━●━━━── 3:45` | Redraws every 10 s. The thick part is your chosen section, ● is where playback is. |
| 🎚️ **Jump to…** menu | 20 points spread across the song (or across your section). Pick one to scrub there. |
| ⏪ 15s / 15s ⏩ | Fine adjustment. |
| ✂️ **Section** | Opens a form: type a start and end (`0:45` → `2:10`) and tick *Loop this section*. |
| 🔁 Loop · ↩️ Full song · ⏭ Skip · 🔄 Refresh | Loop the section (or whole song), drop the section, next in queue, redraw now. |

Slash commands do the same things by typing: `/play`, `/seek 1:30`, `/section start:0:45 end:2:10 loop:true`, `/panel`, `/stop`.

## Setup (about 10 minutes)

**1. Create the bot**
1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **General Information** → copy the **Application ID** (this is `CLIENT_ID`).
3. **Bot** → **Reset Token** → copy it (this is `DISCORD_TOKEN`, keep it secret). No privileged intents are needed.
4. **OAuth2 → URL Generator** → scopes `bot` and `applications.commands`; permissions **View Channels, Send Messages, Connect, Speak**. Open the URL and add the bot to your server.

**2. Configure**
```bash
npm install
cp .env.example .env      # then fill in DISCORD_TOKEN, CLIENT_ID and GUILD_ID
```
`GUILD_ID` is your server's ID (Discord settings → Advanced → Developer Mode, then right-click the server → Copy Server ID). With it set, commands appear instantly in that server.

**3. Add music** — put `.mp3 .flac .wav .ogg .opus .m4a` files in `music/` (subfolders are fine). New files are picked up within a minute.

**4. Run**
```bash
npm run deploy   # registers the slash commands (re-run after editing commands.js)
npm start
```
Join a voice channel and type `/play`.

`npm run check` prints the audio dependency report if something won't play. Requires **Node.js 22.12 or newer**.

## How the timeline works

`src/player.js` starts ffmpeg with `-ss <start>` (begin here) and `-t <length>` (stop at the section end) and streams that to Discord. Every seek just starts a new ffmpeg at the new time and swaps it in. Position = where that ffmpeg started + how long Discord has played it, which is what the progress bar shows.

## Files

```
src/index.js            Discord client, slash commands, button/menu/form handlers
src/player.js           Voice connection, queue, seek, sections, loop
src/panel.js            The now-playing panel and the ✂️ Section form
src/library.js          Scans the music folder, reads song lengths
src/time.js             "1:30" ⇄ 90, progress bar drawing
src/commands.js         Slash command definitions
src/deploy-commands.js  Registers the commands with Discord
```

## Hosting

The bot has to stay running to hold a voice connection, so it needs an always-on machine: your PC, a cheap VPS, or a container host like Railway/Fly.io. Serverless platforms (Vercel, Netlify functions) won't work for voice.

## Want a real draggable slider?

That needs a **Discord Activity**: a small web app that opens inside the voice channel, where you can use a normal `<input type="range">`. The Activity would call your bot's server (e.g. `POST /seek`) and the bot would call `player.seek()` exactly as the buttons do here. It's a bigger build (Embedded App SDK + OAuth + a hosted page), so this bot sticks to native components.
