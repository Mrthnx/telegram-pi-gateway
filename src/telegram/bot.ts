import { Bot, type Context } from "grammy";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AppConfig } from "../config/env";
import type { JsonStore, ProjectChoice } from "../persistence/store";
import { findProjects } from "../projects/discovery";
import type { PiGatewaySessions } from "../pi/session-manager";
import { splitTelegramMessage } from "../utils/messages";

export function createTelegramBot(config: AppConfig, store: JsonStore, piSessions: PiGatewaySessions): Bot {
  const bot = new Bot(config.telegramBotToken);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId !== config.allowedUserId) {
      await ctx.reply("No autorizado.");
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => ctx.reply(helpText()));
  bot.command("help", async (ctx) => ctx.reply(helpText()));
  bot.command("workdir", async (ctx) => ctx.reply(`WORK_DIR:\n${config.workDir}`));
  bot.command("current", async (ctx) => {
    const state = await store.readState();
    await ctx.reply(state.activeProjectPath ? `Proyecto activo:\n${state.activeProjectPath}` : "No hay proyecto activo. Usá /projects o /use.");
  });

  bot.command("projects", async (ctx) => {
    const query = commandArg(ctx);
    const matches = await findProjects(config.workDir, query);
    if (matches.length === 0) {
      await ctx.reply("No encontré proyectos para esa búsqueda.");
      return;
    }
    await saveChoicesAndReply(ctx, store, matches);
  });

  bot.command("use", async (ctx) => {
    const query = commandArg(ctx);
    if (!query) {
      await ctx.reply("Usá /use <nombre-o-ruta-relativa>.");
      return;
    }
    const matches = await findProjects(config.workDir, query);
    if (matches.length === 0) {
      await ctx.reply("No encontré ese proyecto dentro de WORK_DIR.");
      return;
    }
    if (matches.length === 1) {
      await selectProject(ctx, store, matches[0]);
      return;
    }
    await saveChoicesAndReply(ctx, store, matches);
  });

  bot.command("reset", async (ctx) => {
    const state = await store.readState();
    if (!state.activeProjectPath) {
      await ctx.reply("No hay proyecto activo para reiniciar.");
      return;
    }
    await piSessions.reset(state.activeProjectPath);
    await ctx.reply("Sesión de Pi reiniciada para el proyecto activo.");
  });

  bot.command("sessions", async (ctx) => {
    const sessions = await store.readSessions();
    if (sessions.length === 0) {
      await ctx.reply("No hay sesiones guardadas todavía.");
      return;
    }
    await ctx.reply(sessions.map((item, index) => `${index + 1}. ${item.projectPath}`).join("\n"));
  });

  bot.command("resume", async (ctx) => {
    const state = await store.readState();
    if (!state.activeProjectPath) {
      await ctx.reply("No hay proyecto activo para recuperar.");
      return;
    }
    await piSessions.get(state.activeProjectPath);
    await ctx.reply(`Sesión recuperada para:\n${state.activeProjectPath}`);
  });

  bot.on("message:photo", async (ctx) => handlePhoto(ctx, config, store, piSessions));
  bot.on("message:text", async (ctx) => handleText(ctx, store, piSessions));

  return bot;
}

async function handleText(ctx: Context, store: JsonStore, piSessions: PiGatewaySessions): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  const maybeChoice = Number(text);
  const state = await store.readState();
  if (Number.isSafeInteger(maybeChoice) && state.pendingProjectChoices?.[maybeChoice - 1]) {
    await selectProject(ctx, store, state.pendingProjectChoices[maybeChoice - 1]);
    return;
  }

  if (!state.activeProjectPath) {
    await ctx.reply("Primero seleccioná un proyecto con /projects <búsqueda> o /use <nombre>.");
    return;
  }

  await runPiPrompt(ctx, piSessions, state.activeProjectPath, text);
}

async function handlePhoto(ctx: Context, config: AppConfig, store: JsonStore, piSessions: PiGatewaySessions): Promise<void> {
  const state = await store.readState();
  if (!state.activeProjectPath) {
    await ctx.reply("Primero seleccioná un proyecto antes de mandar fotos.");
    return;
  }

  const photos = ctx.message?.photo;
  const largest = photos?.at(-1);
  if (!largest) return;

  const file = await ctx.api.getFile(largest.file_id);
  if (!file.file_path) {
    await ctx.reply("No pude obtener la foto desde Telegram.");
    return;
  }

  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const ext = extname(file.file_path) || ".jpg";
  const downloadsDir = join(config.dataDir, "downloads");
  await mkdir(downloadsDir, { recursive: true });
  const path = join(downloadsDir, `${Date.now()}-${largest.file_unique_id}${ext}`);
  await writeFile(path, bytes);

  const caption = ctx.message?.caption?.trim();
  const prompt = [
    "El usuario envió una foto desde Telegram.",
    `Ruta local descargada: ${path}`,
    caption ? `Caption del usuario: ${caption}` : undefined,
    "Si el modelo/herramientas disponibles no pueden leer imágenes, explicá esa limitación y pedí una descripción textual.",
  ].filter(Boolean).join("\n");

  await runPiPrompt(ctx, piSessions, state.activeProjectPath, prompt);
}

async function runPiPrompt(ctx: Context, piSessions: PiGatewaySessions, projectPath: string, prompt: string): Promise<void> {
  await ctx.reply("Trabajando...");
  const handle = await piSessions.get(projectPath);
  await handle.session.prompt(prompt);
  const answer = handle.session.getLastAssistantText() ?? "";
  for (const chunk of splitTelegramMessage(answer)) await ctx.reply(chunk);
}

async function saveChoicesAndReply(ctx: Context, store: JsonStore, matches: ProjectChoice[]): Promise<void> {
  const state = await store.readState();
  await store.writeState({ ...state, pendingProjectChoices: matches });
  await ctx.reply([
    "Encontré estos proyectos:",
    "",
    ...matches.map((item, index) => `${index + 1}. ${item.name} — ${item.path}`),
    "",
    "Respondé con el número o usá /use <nombre-o-ruta>.",
  ].join("\n"));
}

async function selectProject(ctx: Context, store: JsonStore, project: ProjectChoice): Promise<void> {
  await store.writeState({ activeProjectPath: project.path, pendingProjectChoices: undefined });
  await ctx.reply(`Proyecto activo:\n${project.path}`);
}

function commandArg(ctx: Context): string {
  const text = ctx.message?.text ?? "";
  return text.replace(/^\/\w+(@\w+)?\s*/u, "").trim();
}

function helpText(): string {
  return [
    "Telegram Pi Gateway",
    "",
    "Comandos:",
    "/workdir — muestra el WORK_DIR",
    "/projects <búsqueda> — busca proyectos",
    "/use <nombre-o-ruta> — selecciona proyecto",
    "/current — muestra el proyecto activo",
    "/reset — reinicia la sesión Pi del proyecto activo",
    "/sessions — lista sesiones guardadas",
    "/resume — recupera la sesión del proyecto activo",
    "/help — muestra esta ayuda",
    "",
    "Después de elegir proyecto, escribí normalmente y Pi responderá desde ese cwd.",
  ].join("\n");
}
