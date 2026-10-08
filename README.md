# Telegram Pi Gateway

Local personal Telegram gateway for Pi SDK. It lets one authorized Telegram user select a project under `WORK_DIR` and talk to Pi with that project as the current working directory.

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
```

See `env.example`.

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

## Download

```bash
git clone https://github.com/Mrthnx/telegram-pi-gateway.git
cd telegram-pi-gateway
```

## Recommended run mode: Docker

Docker is the recommended way to run the gateway because it keeps the bot alive after closing the terminal.

## Optional local development

Use this only while editing the project interactively:

```bash
bun install
bun dev
```

`bun dev` runs with file watching and stops when the terminal/session ends. For normal usage, prefer Docker.

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

## Photos

The bot accepts Telegram photos, downloads the largest available image into `DATA_DIR/downloads`, and prompts Pi with the local image path plus any caption. Full multimodal handling depends on the active Pi model/SDK support; if the model cannot inspect images, Pi should ask for a textual description.

## Pi package gallery

This repository includes npm metadata for Pi package discovery: `pi-package` keyword, repository links, license, and public package files.

To appear on [pi.dev/packages](https://pi.dev/packages), the package still needs to be published or indexed from an eligible package source. The GitHub repository alone is not enough for npm keyword discovery.

## Security notes

- The Telegram token must never be sent through chat.
- Only `TELEGRAM_ALLOWED_USER_ID` can use the bot.
- Project paths are resolved under `WORK_DIR`.
- Heavy folders such as `node_modules`, `.git`, `dist`, `build`, `.next`, `vendor`, and caches are ignored during discovery.
