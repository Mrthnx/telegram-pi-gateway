import { Bot, InlineKeyboard, type Context } from "grammy";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AppConfig } from "../config/env";
import type { JsonStore, ProjectChoice } from "../persistence/store";
import { findProjects } from "../projects/discovery";
import type { PiGatewaySessions } from "../pi/session-manager";
import { splitTelegramMessage } from "../utils/messages";
import type { TelegramInteractionBridge } from "./interactions";

export function createTelegramBot(
  config: AppConfig,
  store: JsonStore,
  piSessions: PiGatewaySessions,
  telegramBridge: TelegramInteractionBridge,
): Bot {
  const bot = new Bot(config.telegramBotToken);
  telegramBridge.bindBot();

  bot.catch((error) => {
    console.error("[telegram-bot:error]", {
      error: error.error instanceof Error ? { name: error.error.name, message: error.error.message } : String(error.error),
    });
  });

  bot.use(async (ctx, next) => {
    await next();
  });

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

  bot.callbackQuery(/^pi:(answer|free-text):/u, async (ctx) => {
    telegramBridge.bindOwnerChat(ctx);
    await telegramBridge.handleChoiceCallback(ctx);
  });

  bot.callbackQuery(/^project:select:(\d+)$/u, async (ctx) => handleProjectSelectionCallback(ctx, store));

  bot.on("message:photo", async (ctx) => handlePhoto(ctx, config, store, piSessions, telegramBridge));
  bot.on("message:text", async (ctx) => handleText(ctx, store, piSessions, telegramBridge));

  return bot;
}

async function handleText(
  ctx: Context,
  store: JsonStore,
  piSessions: PiGatewaySessions,
  telegramBridge: TelegramInteractionBridge,
): Promise<void> {
  telegramBridge.bindOwnerChat(ctx);
  const text = ctx.message?.text?.trim();
  if (!text) return;

  if (await telegramBridge.tryResolveText(ctx, text)) return;

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

  void runPiPrompt(ctx, piSessions, state.activeProjectPath, text).catch((error) => {
    console.error("[pi-run:unhandled]", error instanceof Error ? { name: error.name, message: error.message } : error);
  });
}

async function handlePhoto(
  ctx: Context,
  config: AppConfig,
  store: JsonStore,
  piSessions: PiGatewaySessions,
  telegramBridge: TelegramInteractionBridge,
): Promise<void> {
  telegramBridge.bindOwnerChat(ctx);
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

  void runPiPrompt(ctx, piSessions, state.activeProjectPath, prompt).catch((error) => {
    console.error("[pi-run:unhandled]", error instanceof Error ? { name: error.name, message: error.message } : error);
  });
}

async function runPiPrompt(ctx: Context, piSessions: PiGatewaySessions, projectPath: string, prompt: string): Promise<void> {
  const requestId = `${Date.now()}-${ctx.message?.message_id ?? "unknown"}`;
  let unsubscribe: (() => void) | undefined;
  let streamedAnswer = "";
  let completedAnswer = "";
  let promptDisposition = "unknown";

  const chatId = ctx.chat?.id;
  const initialStatus = await ctx.reply("🧠 Pi trabajando…");
  let statusMessageId = chatId !== undefined ? initialStatus.message_id : undefined;
  let lastStatusText = "🧠 Pi trabajando…";
  let lastStatusEditAt = 0;
  let pendingStatusText: string | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let toolsRun = 0;

  const editStatusMessage = async (text: string): Promise<void> => {
    if (statusMessageId === undefined || chatId === undefined) return;
    try {
      await ctx.api.editMessageText(chatId, statusMessageId, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not modified|message to edit not found|message is empty/i.test(message)) {
        console.warn("[pi-run:status-edit-failed]", { requestId, message });
      }
    }
  };

  const deleteStatusMessage = async (): Promise<void> => {
    if (statusMessageId === undefined || chatId === undefined) return;
    const messageId = statusMessageId;
    statusMessageId = undefined;
    try {
      await ctx.api.deleteMessage(chatId, messageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/message to delete not found/i.test(message)) {
        console.warn("[pi-run:status-delete-failed]", { requestId, message });
      }
    }
  };

  const pushStatus = (text: string): void => {
    if (text === lastStatusText || statusMessageId === undefined) return;
    const now = Date.now();
    if (now - lastStatusEditAt >= STATUS_EDIT_MIN_INTERVAL_MS) {
      lastStatusEditAt = now;
      lastStatusText = text;
      void editStatusMessage(text);
      return;
    }
    pendingStatusText = text;
    if (statusTimer === undefined) {
      statusTimer = setTimeout(() => {
        statusTimer = undefined;
        const pending = pendingStatusText;
        pendingStatusText = undefined;
        if (pending === undefined || pending === lastStatusText || statusMessageId === undefined) return;
        lastStatusEditAt = Date.now();
        lastStatusText = pending;
        void editStatusMessage(pending);
      }, STATUS_EDIT_MIN_INTERVAL_MS - (now - lastStatusEditAt));
    }
  };

  const clearStatusTimer = (): void => {
    if (statusTimer !== undefined) {
      clearTimeout(statusTimer);
      statusTimer = undefined;
    }
  };

  const updateStatusFromEvent = (event: { type: string; [key: string]: unknown }): void => {
    switch (event.type) {
      case "agent_start":
        pushStatus(formatActivity("🧠 Pi trabajando…", toolsRun));
        return;
      case "tool_execution_start":
        toolsRun += 1;
        pushStatus(formatToolStatus("🔧", String(event.toolName ?? "tool"), event.args, toolsRun));
        return;
      case "tool_execution_end":
        if (event.isError) pushStatus(formatActivity(`⚠️ ${String(event.toolName ?? "tool")} falló`, toolsRun));
        return;
      case "compaction_start":
        pushStatus(formatActivity("📦 Compactando contexto…", toolsRun));
        return;
      case "auto_retry_start":
        pushStatus(formatActivity(`🔁 Reintentando (intento ${event.attempt ?? "?"}/${event.maxAttempts ?? "?"})…`, toolsRun));
        return;
      case "agent_end":
        pushStatus(formatActivity("✓ Listo", toolsRun));
        return;
      default:
        return;
    }
  };

  console.info("[pi-run:start]", {
    requestId,
    projectPath,
    chatId: ctx.chat?.id,
    messageId: ctx.message?.message_id,
    promptLength: prompt.length,
    promptPreview: previewText(prompt),
  });

  try {
    const handle = await piSessions.get(projectPath);
    console.info("[pi-run:session-ready]", {
      requestId,
      sessionId: handle.id,
      existingMessages: handle.session.messages.length,
      model: handle.session.model?.id,
      activeTools: handle.session.getActiveToolNames(),
    });

    unsubscribe = handle.session.subscribe((event) => {
      logPiEvent(requestId, event);
      updateStatusFromEvent(event);
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        streamedAnswer += event.assistantMessageEvent.delta;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        completedAnswer = extractAssistantText(event.message);
        console.info("[pi-run:message-end-assistant]", {
          requestId,
          completedAnswerLength: completedAnswer.length,
          completedAnswerPreview: previewText(completedAnswer),
          message: summarizeMessage(event.message),
        });
      }
      if (event.type === "agent_end") {
        const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
        if (lastAssistant) completedAnswer = extractAssistantText(lastAssistant);
        console.info("[pi-run:agent-end]", {
          requestId,
          willRetry: event.willRetry,
          messageCount: event.messages.length,
          completedAnswerLength: completedAnswer.length,
          lastMessages: summarizeLastMessages(event.messages),
        });
      }
    });

    await handle.session.prompt(prompt, {
      source: "rpc",
      preflightResult: (disposition) => {
        promptDisposition = disposition;
        console.info("[pi-run:preflight]", { requestId, disposition });
      },
    });

    unsubscribe();
    unsubscribe = undefined;

    const lastAssistant = [...handle.session.messages].reverse().find((message) => message.role === "assistant") as
      | { stopReason?: string; errorMessage?: string }
      | undefined;
    const lastAssistantText = handle.session.getLastAssistantText() ?? "";
    const answer = completedAnswer.trim() || lastAssistantText || streamedAnswer.trim();
    console.info("[pi-run:answer-selected]", {
      requestId,
      promptDisposition,
      completedAnswerLength: completedAnswer.trim().length,
      lastAssistantTextLength: lastAssistantText.length,
      streamedAnswerLength: streamedAnswer.trim().length,
      selectedAnswerLength: answer.trim().length,
      selectedAnswerPreview: previewText(answer),
      finalMessageCount: handle.session.messages.length,
      lastMessages: summarizeLastMessages(handle.session.messages),
    });

    if (!answer.trim()) {
      console.warn("[pi-run:empty-answer] Pi run completed without textual assistant output", {
        requestId,
        projectPath,
        promptDisposition,
        messageCount: handle.session.messages.length,
        lastMessages: summarizeLastMessages(handle.session.messages),
      });
    }

    clearStatusTimer();

    if (!answer.trim() && lastAssistant?.stopReason === "error") {
      const message = lastAssistant.errorMessage
        ? `Pi falló antes de producir una respuesta textual:\n${lastAssistant.errorMessage}`
        : "Pi falló antes de producir una respuesta textual. Revisá los logs del gateway para ver el error del modelo.";
      await deleteStatusMessage();
      for (const chunk of splitTelegramMessage(message)) await ctx.reply(chunk);
      return;
    }

    const chunks = splitTelegramMessage(answer);
    if (chunks.length === 1 && statusMessageId !== undefined && chatId !== undefined) {
      try {
        await ctx.api.editMessageText(chatId, statusMessageId, chunks[0]);
        statusMessageId = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/not modified|message to edit not found|message is empty/i.test(message)) {
          console.warn("[pi-run:status-morph-failed]", { requestId, message });
        }
        await deleteStatusMessage();
        await ctx.reply(chunks[0]);
      }
      return;
    }

    await deleteStatusMessage();
    for (const chunk of chunks) await ctx.reply(chunk);
  } catch (error) {
    unsubscribe?.();
    clearStatusTimer();
    await editStatusMessage("⚠️ Ocurrió un error. Revisá los logs del gateway.").catch(() => undefined);
    console.error("[pi-run:error]", {
      requestId,
      projectPath,
      promptDisposition,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
    });
    throw error;
  }
}

const STATUS_EDIT_MIN_INTERVAL_MS = 900;

function formatActivity(label: string, toolsRun: number): string {
  return toolsRun > 0 ? `${label} · ${toolsRun}` : label;
}

function formatToolStatus(emoji: string, toolName: string, args: unknown, toolsRun: number): string {
  const hint = toolArgHint(toolName, args);
  const head = hint ? `${emoji} ${toolName} — ${hint}` : `${emoji} ${toolName}`;
  return `${head} · ${toolsRun}`;
}

function toolArgHint(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  switch (toolName) {
    case "bash":
      return truncateToFirstLine(String(a.command ?? ""));
    case "read":
    case "edit":
    case "write":
      return String(a.path ?? "");
    case "grep":
    case "find":
      return String(a.pattern ?? "");
    case "todo":
      return String(a.action ?? "");
    case "web_search":
      return truncateToFirstLine(String(a.query ?? ""));
    case "subagent_run":
      return String(a.agent ?? "");
    default:
      return "";
  }
}

function truncateToFirstLine(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

function extractAssistantText(message: { content: Array<{ type?: string; text?: string }> }): string {
  return message.content
    .filter((content) => typeof content.text === "string")
    .map((content) => content.text)
    .join("")
    .trim();
}

function logPiEvent(requestId: string, event: { type: string; [key: string]: unknown }): void {
  switch (event.type) {
    case "message_update": {
      const assistantEvent = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (assistantEvent?.type === "text_delta") {
        console.info("[pi-run:event]", { requestId, type: event.type, assistantEventType: assistantEvent.type, deltaLength: assistantEvent.delta?.length ?? 0 });
      } else {
        console.info("[pi-run:event]", { requestId, type: event.type, assistantEventType: assistantEvent?.type });
      }
      return;
    }
    case "message_end":
      console.info("[pi-run:event]", { requestId, type: event.type, message: summarizeMessage(event.message) });
      return;
    case "agent_end":
      console.info("[pi-run:event]", { requestId, type: event.type, willRetry: event.willRetry });
      return;
    case "tool_execution_start":
    case "tool_execution_end":
      console.info("[pi-run:event]", { requestId, type: event.type, toolName: event.toolName, isError: event.isError });
      return;
    default:
      console.info("[pi-run:event]", { requestId, type: event.type });
  }
}

function summarizeMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const record = message as {
    role?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    rawStopReason?: unknown;
    provider?: unknown;
    model?: unknown;
    responseModel?: unknown;
    diagnostics?: unknown;
    content?: unknown;
  };
  return {
    role: record.role,
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
    rawStopReason: record.rawStopReason,
    provider: record.provider,
    model: record.model,
    responseModel: record.responseModel,
    diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics : undefined,
    content: Array.isArray(record.content)
      ? record.content.map((content) => summarizeContentPart(content))
      : typeof record.content,
  };
}

function summarizeLastMessages(messages: Array<{ role: string; content?: unknown; stopReason?: string }>) {
  return messages.slice(-5).map((message) => summarizeMessage(message));
}

function summarizeContentPart(content: unknown): { type?: string; textLength: number } {
  if (!content || typeof content !== "object") return { textLength: 0 };
  const record = content as { type?: unknown; text?: unknown };
  return {
    type: typeof record.type === "string" ? record.type : undefined,
    textLength: typeof record.text === "string" ? record.text.length : 0,
  };
}

function previewText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 200);
}

async function saveChoicesAndReply(ctx: Context, store: JsonStore, matches: ProjectChoice[]): Promise<void> {
  const state = await store.readState();
  await store.writeState({ ...state, pendingProjectChoices: matches });

  const keyboard = new InlineKeyboard();
  for (const [index, item] of matches.entries()) {
    keyboard.text(`${index + 1}. ${item.name}`.slice(0, 64), `project:select:${index}`).row();
  }

  await ctx.reply([
    "Encontré estos proyectos:",
    "",
    ...matches.map((item, index) => `${index + 1}. ${item.name} — ${item.path}`),
    "",
    "Elegí con los botones o usá /use <nombre-o-ruta>.",
  ].join("\n"), { reply_markup: keyboard });
}

async function handleProjectSelectionCallback(ctx: Context, store: JsonStore): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const match = data?.match(/^project:select:(\d+)$/u);
  if (!match) return;

  const state = await store.readState();
  const project = state.pendingProjectChoices?.[Number(match[1])];
  if (!project) {
    await ctx.answerCallbackQuery({ text: "Esa selección ya no está activa.", show_alert: true }).catch(() => undefined);
    return;
  }

  await ctx.answerCallbackQuery({ text: "Proyecto seleccionado." }).catch(() => undefined);
  await selectProject(ctx, store, project);
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
