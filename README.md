# Telegram Pi Gateway

Standalone local Telegram gateway for Pi SDK. It runs outside the Pi process, lets one authorized Telegram user select a project under `WORK_DIR`, and talks to Pi with that project as the current working directory.

## Requirements

- Docker Desktop for the recommended run mode
- Bun for optional local development
- A Telegram bot token from BotFather
- Pi already configured locally (`pi` login/settings/extensions/skills)

## Configuration

Set these variables in your shell profile (`.zshrc`, `.bashrc`) or process environment:

```bash
export TELEGRAM_BOT_TOKEN="123:bot-token"
export TELEGRAM_ALLOWED_USER_ID="123456789"
export WORK_DIR="/Users/you/Developer"
export DATA_DIR="./data" # optional
export TELEGRAM_PI_MODEL="minimax/MiniMax-M3" # optional
```

See `env.example`.

### Model selection

The gateway resolves the model it uses for Pi sessions as a `provider/id` pair. It picks it in this order:

1. `TELEGRAM_PI_MODEL` — the gateway-owned variable. Use it to pin a model explicitly, as `provider/id`.
2. `PI_MODEL` inherited from the Pi harness. If it already contains a `/`, it is used as-is. If it is a bare model id, it is composed with `PI_PROVIDER` (`minimax` + `MiniMax-M3` becomes `minimax/MiniMax-M3`).
3. Neither is set, or a bare `PI_MODEL` has no `PI_PROVIDER` companion — the gateway uses the default Pi model and logs a warning.

`PI_MODEL` and `PI_PROVIDER` are Pi harness variables, not gateway variables. The gateway inherits them whenever it is started from a Pi session, which is why the bare-id case is composed instead of rejected.

## Create and configure the Telegram bot

Use Telegram's official [@BotFather](https://t.me/BotFather) bot to create and manage your bot.

### 1. Create the bot

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Choose a display name, for example `Pi Gateway`.
4. Choose a username ending in `bot`, for example `my_pi_gateway_bot`.
5. BotFather returns an HTTP API token. Use that value as `TELEGRAM_BOT_TOKEN`.
6. Start a chat with your new bot and press **Start**.

Keep the bot token private. Anyone with the token can control your bot.

### 2. Get your Telegram user id

1. Open [@userinfo](https://t.me/userinfo) in Telegram.
2. Copy your numeric Telegram user id.
3. Use that value as `TELEGRAM_ALLOWED_USER_ID`.

Only this Telegram user id can use the gateway.

### 3. Configure the bot profile in BotFather

Open [@BotFather](https://t.me/BotFather), send `/mybots`, select your bot, and configure these settings:

- **Edit Bot → Edit Description** (`/setdescription`): shown as "What can this bot do?" when a user opens the bot.
  Suggested text:

  ```text
  Personal Telegram gateway for Pi coding-agent sessions. Select a local project and talk to Pi from Telegram.
  ```

- **Edit Bot → Edit About** (`/setabouttext`): short bot profile bio.
  Suggested text:

  ```text
  Personal Pi coding-agent gateway.
  ```

- **Edit Bot → Edit Commands** (`/setcommands`): command menu shown by Telegram.
  Paste this list:

  ```text
  start - Show help and start the bot
  help - Show available commands
  workdir - Show the configured work directory
  projects - Search local projects
  use - Select a project
  current - Show the active project
  reset - Reset the active Pi session
  sessions - List remembered project sessions
  resume - Recover the active project session
  ```

- **Bot Settings → Allow Groups?** (`/setjoingroups`): keep groups disabled if this is a personal bot.
- **Bot Settings → Group Privacy** (`/setprivacy`): keep privacy enabled unless you intentionally add the bot to groups and need it to read group messages.
- Optional: **Edit Botpic** (`/setuserpic`) to set a profile image.

### 4. Recover or rotate a lost BotFather token

If you lost the token or think it leaked:

1. Open [@BotFather](https://t.me/BotFather).
2. Send `/mybots`.
3. Select your bot.
4. Choose **API Token**.
5. Use the shown token, or choose **Revoke current token** to rotate it and generate a new one.
6. Update `TELEGRAM_BOT_TOKEN` in your `.env` or deployment environment.
7. Restart the gateway.

BotFather also supports the direct `/token` command for token management.

References: [Telegram Bot Features](https://core.telegram.org/bots/features), [Telegram Bot Commands](https://core.telegram.org/api/bots/commands).

## Install

This gateway runs outside Pi. Do not install it with `pi install`; install and run it as a normal background service.

### From npm

Install Bun first, because the gateway executes TypeScript with Bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then install the gateway globally:

```bash
npm install -g telegram-pi-gateway
```

Set the required environment variables, then run it in the foreground:

```bash
export TELEGRAM_BOT_TOKEN="123:bot-token"
export TELEGRAM_ALLOWED_USER_ID="123456789"
export WORK_DIR="/Users/you/Developer"
export DATA_DIR="$HOME/.telegram-pi-gateway/data"

telegram-pi-gateway
```

### Run in background with PM2

PM2 is the recommended npm-based background runner:

```bash
npm install -g pm2
pm2 start telegram-pi-gateway --name telegram-pi-gateway --update-env
pm2 save
```

Useful PM2 commands:

```bash
pm2 logs telegram-pi-gateway
pm2 restart telegram-pi-gateway --update-env
pm2 stop telegram-pi-gateway
```

To start again after reboot, run the command printed by:

```bash
pm2 startup
```

and then:

```bash
pm2 save
```

### From GitHub

```bash
git clone https://github.com/Mrthnx/telegram-pi-gateway.git
cd telegram-pi-gateway
bun install
bun start
```

For development with file watching:

```bash
bun dev
```

## Recommended run mode: Docker

Docker remains a good run mode if you prefer a containerized long-running process.

## Docker

Create a local `.env` file first:

```bash
cp env.example .env
```

Edit `.env` with your values:

```bash
TELEGRAM_BOT_TOKEN="123:bot-token"
TELEGRAM_ALLOWED_USER_ID="123456789"
WORK_DIR="/Users/you/Developer"
DATA_DIR="/app/data"
```

Build and start the container in the background. Source `.env` first because Docker volume paths are expanded by your shell, not by `--env-file`:

```bash
set -a && source .env && set +a
docker build -t telegram-pi-gateway .
docker run -d \
  --name telegram-pi-gateway \
  --restart unless-stopped \
  --env-file .env \
  -v "$WORK_DIR:$WORK_DIR" \
  -v "$PWD/data:/app/data" \
  -v "$HOME/.pi:$HOME/.pi" \
  -v "$HOME/.config:$HOME/.config" \
  telegram-pi-gateway
```

Useful commands:

```bash
# See logs
docker logs -f telegram-pi-gateway

# Stop it
docker stop telegram-pi-gateway

# Start it again
docker start telegram-pi-gateway

# Rebuild after code changes
docker stop telegram-pi-gateway && docker rm telegram-pi-gateway
docker build -t telegram-pi-gateway .
```

The container uses `--restart unless-stopped`, so it keeps running after the terminal closes and starts again after Docker restarts.

Docker needs access to your host Pi configuration, credentials, skills, and project folders, so the command mounts `$HOME/.pi`, `$HOME/.config`, and `$WORK_DIR` into the container.

## Telegram commands

- `/start` / `/help` — help
- `/workdir` — show configured `WORK_DIR`
- `/projects <query>` — search projects
- `/use <name-or-relative-path>` — select one project
- `/current` — show active project
- `/reset` — reset active Pi session
- `/sessions` — list remembered project sessions
- `/resume` — warm up/recover the active project session

After selecting a project, send normal messages. The bot replies `Trabajando...` while Pi runs and then sends the answer, split across multiple Telegram messages if needed.

## Images

The bot accepts Telegram photos and image documents. It downloads the largest available image into `DATA_DIR/downloads` and attaches it to the Pi prompt, so the model looks at the picture directly instead of receiving a path and having to go fetch it. The local path and the caption are passed along as well, so the agent can crop, edit or otherwise work on the file.

Two limits are enforced:

- Telegram only lets a bot download files of up to 20 MB.
- Images larger than 5 MB are kept on disk instead of being attached inline. The bot says so in chat instead of failing silently.

If the active model does not accept image input, the bot tells you and passes only the file path. A model accepts images when it declares `image` in its input capabilities; `minimax/MiniMax-M3` does, `minimax/MiniMax-M2.7` does not.

## Voice notes

The bot accepts Telegram voice notes and audio files. It downloads the audio, normalizes it to 16 kHz mono with `ffmpeg`, transcribes it with a **local** engine and sends the transcript to Pi, so the audio never leaves your machine.

The gateway looks for an engine in this order:

1. `mlx-whisper` — `pip install mlx-whisper` (Apple Silicon, fastest, models download on first use).
2. `whisper.cpp` — `brew install whisper.cpp`, plus the multilingual model:

   ```bash
   mkdir -p ~/.cache/whisper
   curl -fL -o ~/.cache/whisper/ggml-base.bin \
     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
   ```

   Use `ggml-base.bin`, not `ggml-base.en.bin`: the English-only model mistranslates everything else.
3. The `openai-whisper` CLI — `pip install openai-whisper`.

If none is installed the bot says so and keeps the file in `DATA_DIR/downloads`. To use a different engine, set `TELEGRAM_STT_COMMAND` to a JSON array of arguments, where `{audio}` is the normalized WAV and `{workdir}` is the scratch directory. The transcript is read from `{workdir}/transcript.txt` when the command writes it, and from the command output otherwise:

```bash
export TELEGRAM_STT_COMMAND='["/path/to/transcriber","{audio}","--txt","{workdir}"]'
```

`TELEGRAM_STT_LANGUAGE` overrides the spoken language. It defaults to `auto`, which matters for `whisper-cli`: its own default is English.

`ffmpeg` has to be installed. `brew install ffmpeg`.

## Answering with media

Two Pi tools let the agent send you files:

- `telegram_send_media` delivers a file from the active project (or from `DATA_DIR`) as a photo, a document or a voice note. The kind is inferred from the extension. Voice notes are only playable for `.ogg`, `.oga`, `.mp3` and `.m4a`; anything else is delivered as a document.
- `telegram_send_voice` turns a text answer into a spoken voice note. The text is spoken and encoded as OGG/OPUS, which is the format Telegram renders as a playable voice note.

Files sent to Telegram are limited by the Bot API: 10 MB for a photo, 50 MB for a document or a voice note.

### Speech engines

The voice note engine is picked in this order:

1. `TELEGRAM_TTS_COMMAND` — an explicit engine, as a JSON array of arguments. `{text}` is the text to speak, `{output}` is the file the engine has to write, and the text is also fed on stdin.
2. **Piper** — a local neural engine, natural sounding and free. It needs `pip install piper-tts` plus a downloaded model:

   ```bash
   pip install piper-tts
   mkdir -p ~/.local/share/piper
   curl -fL -o ~/.local/share/piper/es_ES-sharvard-medium.onnx \
     https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx
   curl -fL -o ~/.local/share/piper/es_ES-sharvard-medium.onnx.json \
     https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx.json
   ```

   The gateway finds the model in `~/.local/share/piper` on its own, and `TELEGRAM_TTS_MODEL` overrides the location. `pip install --user` puts the `piper` script in `~/Library/Python/<version>/bin`, outside PATH; the gateway looks there too, so no PATH change is needed.

3. **macOS `say`** — the fallback. It needs nothing, but its voices are the classic non-neural ones and they sound robotic. The only non-novelty Spanish voices macOS ships are `Mónica` and `Paulina`.

`TELEGRAM_VOICE` sets the voice used when the owner does not name one. The voice is validated against the voices the engine actually exposes, so a typo is an error instead of a silent fallback to the default voice. A neural engine has one fixed voice, so a named voice is ignored there and the tool reports which engine and voice actually spoke.

## Pi package gallery

This project is a standalone Pi SDK gateway, not an in-process Pi extension or plugin. It does not register Pi tools, commands, event handlers, prompts, skills, or themes through a `pi` package manifest.

The package keeps the `pi-package` npm keyword so it is eligible for discovery on [pi.dev/packages](https://pi.dev/packages), together with the repository, homepage, license, and public package metadata in `package.json`.

To appear on the package gallery, the package still needs to be published or indexed from an eligible package source. The GitHub repository alone is not enough for npm keyword discovery.

## Security notes

- The Telegram token must never be sent through chat.
- Only `TELEGRAM_ALLOWED_USER_ID` can use the bot.
- Project paths are resolved under `WORK_DIR`.
- Heavy folders such as `node_modules`, `.git`, `dist`, `build`, `.next`, `vendor`, and caches are ignored during discovery.
