import { loadConfig } from "./config/env";
import { JsonStore } from "./persistence/store";
import { PiGatewaySessions } from "./pi/session-manager";
import { createTelegramBot } from "./telegram/bot";

const config = await loadConfig();
const store = new JsonStore(config.dataDir);
const piSessions = new PiGatewaySessions(store);
const bot = createTelegramBot(config, store, piSessions);

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log("Telegram Pi Gateway starting...");
console.log(`WORK_DIR=${config.workDir}`);
console.log(`DATA_DIR=${config.dataDir}`);

await bot.start({
  onStart(info) {
    console.log(`Telegram bot @${info.username} is running`);
  },
});

async function shutdown(): Promise<void> {
  console.log("Shutting down...");
  bot.stop();
  await piSessions.disposeAll();
  process.exit(0);
}
