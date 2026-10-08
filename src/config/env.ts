import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export type AppConfig = {
  telegramBotToken: string;
  allowedUserId: number;
  workDir: string;
  dataDir: string;
  piModel: string | undefined;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export async function loadConfig(): Promise<AppConfig> {
  const allowed = Number(required("TELEGRAM_ALLOWED_USER_ID"));
  if (!Number.isSafeInteger(allowed)) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID must be a numeric Telegram user id");
  }

  const dataDir = resolve(process.env.DATA_DIR?.trim() || "./data");
  await mkdir(dataDir, { recursive: true });
  await mkdir(resolve(dataDir, "downloads"), { recursive: true });

  return {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    allowedUserId: allowed,
    workDir: resolve(required("WORK_DIR")),
    dataDir,
    piModel: process.env.PI_MODEL?.trim() || undefined,
  };
}
