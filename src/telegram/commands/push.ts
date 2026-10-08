import { randomUUID } from "node:crypto";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { JsonStore } from "../../persistence/store";
import { splitTelegramMessage } from "../../utils/messages";

const PUSH_TIMEOUT_MS = 60_000;
const PENDING_TTL_MS = 5 * 60 * 1000;
const PREVIEW_TIMEOUT_MS = 5_000;

type PendingPush = {
  projectPath: string;
  chatId: number | string;
  messageId: number;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingPushes = new Map<string, PendingPush>();

function rememberPending(id: string, projectPath: string, chatId: number | string, messageId: number): void {
  const timeout = setTimeout(() => {
    pendingPushes.delete(id);
  }, PENDING_TTL_MS);
  pendingPushes.set(id, { projectPath, chatId, messageId, timeout });
}

function takePending(id: string): PendingPush | undefined {
  const pending = pendingPushes.get(id);
  if (!pending) return undefined;
  clearTimeout(pending.timeout);
  pendingPushes.delete(id);
  return pending;
}

type GitResult = { stdout: string; stderr: string };
type GitError = Error & { stdout?: string; stderr?: string; code?: number };

async function gitRemoteOriginUrl(cwd: string): Promise<string | undefined> {
  try {
    const result = await git(cwd, ["config", "--get", "remote.origin.url"], PREVIEW_TIMEOUT_MS);
    const value = result.stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch (error) {
    const err = error as GitError;
    if (err.code === 1) return undefined;
    throw error;
  }
}

async function git(cwd: string, args: string[], timeoutMs: number): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const killTimer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const err: GitError = new Error(`git ${args.join(" ")} exited with code ${exitCode}`);
      err.stdout = stdout;
      err.stderr = stderr;
      err.code = exitCode;
      throw err;
    }
    return { stdout, stderr };
  } finally {
    clearTimeout(killTimer);
  }
}

type PushPreview = {
  branch: string;
  remoteUrl: string;
  ahead: number;
  behind: number;
};

async function readPushPreview(cwd: string): Promise<PushPreview> {
  const [insideWorkTree, branchResult, remoteResult] = await Promise.all([
    git(cwd, ["rev-parse", "--is-inside-work-tree"], PREVIEW_TIMEOUT_MS),
    git(cwd, ["symbolic-ref", "--short", "HEAD"], PREVIEW_TIMEOUT_MS),
    gitRemoteOriginUrl(cwd),
  ]);

  if (insideWorkTree.stdout.trim() !== "true") {
    throw new Error("No es un working tree de Git.");
  }
  const branch = branchResult.stdout.trim();
  if (!branch) {
    throw new Error("HEAD no apunta a una rama local. Hacele commit a algo primero.");
  }
  if (!remoteResult) {
    throw new Error("No hay remote `origin` configurado. Configuralo antes de hacer push.");
  }
  const remoteUrl = remoteResult;

  let ahead = 0;
  let behind = 0;
  try {
    const countResult = await git(cwd, ["rev-list", "--left-right", "--count", "@{u}...HEAD"], PREVIEW_TIMEOUT_MS);
    const [behindRaw, aheadRaw] = countResult.stdout.trim().split(/\s+/u);
    const parsedAhead = Number.parseInt(aheadRaw ?? "0", 10);
    const parsedBehind = Number.parseInt(behindRaw ?? "0", 10);
    if (!Number.isFinite(parsedAhead) || !Number.isFinite(parsedBehind)) {
      throw new Error(`No pude interpretar el delta con el upstream: ${countResult.stdout.trim() || "(vacío)"}`);
    }
    ahead = parsedAhead;
    behind = parsedBehind;
  } catch (error) {
    const err = error as GitError;
    const stderr = err.stderr ?? "";
    if (err.code === 128 && /no upstream configured for branch/iu.test(stderr)) {
      const localCount = await git(cwd, ["rev-list", "--count", "HEAD"], PREVIEW_TIMEOUT_MS);
      const parsed = Number.parseInt(localCount.stdout.trim(), 10);
      ahead = Number.isFinite(parsed) ? parsed : 0;
    } else if (err.code === 128 && /unknown revision/u.test(stderr)) {
      ahead = 0;
    } else {
      throw error;
    }
  }

  return { branch, remoteUrl, ahead, behind };
}

function formatPreview(projectPath: string, preview: PushPreview): string {
  const lines = [
    "🚀 Push plan",
    `Proyecto: ${projectPath}`,
    `Rama: ${preview.branch}`,
    `Remote: ${preview.remoteUrl}`,
  ];
  if (preview.ahead === 0 && preview.behind === 0) {
    lines.push("Delta: ya está al día con el upstream.");
  } else {
    const parts: string[] = [];
    if (preview.ahead > 0) parts.push(`${preview.ahead} commit${preview.ahead === 1 ? "" : "s"} adelante`);
    if (preview.behind > 0) parts.push(`${preview.behind} commit${preview.behind === 1 ? "" : "s"} detrás`);
    lines.push(`Delta: ${parts.join(", ")}.`);
  }
  if (preview.behind > 0) {
    lines.push("");
    lines.push("⚠️ Tu rama local está detrás del upstream. Un `git push` simple va a fallar hasta que hagas pull o rebase.");
  }
  return lines.join("\n");
}

function buildConfirmKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Push", `pi:push:confirm:${id}`)
    .text("❌ Cancelar", `pi:push:cancel:${id}`);
}

async function replyPushResult(ctx: Context, chatId: number | string, stdout: string, stderr: string): Promise<void> {
  const sections: string[] = [];
  if (stdout.trim()) sections.push(`stdout:\n${stdout.trim()}`);
  if (stderr.trim()) sections.push(`stderr:\n${stderr.trim()}`);
  if (sections.length === 0) sections.push("Push completado sin salida.");
  const combined = sections.join("\n\n");
  for (const chunk of splitTelegramMessage(combined)) {
    await ctx.api.sendMessage(chatId, chunk);
  }
}

function getCallbackMessageId(ctx: Context): number | undefined {
  return ctx.callbackQuery?.message?.message_id;
}

export function registerPushCommand(bot: Bot, store: JsonStore): void {
  bot.command("push", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    const state = await store.readState();
    if (!state.activeProjectPath) {
      await ctx.reply("No hay proyecto activo. Seleccioná uno con /use <nombre>.");
      return;
    }

    const projectPath = state.activeProjectPath;
    let preview: PushPreview;
    try {
      preview = await readPushPreview(projectPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`No pude preparar el push: ${message}`);
      return;
    }

    const id = randomUUID().slice(0, 12);
    const text = formatPreview(projectPath, preview);
    const sent = await ctx.reply(text, { reply_markup: buildConfirmKeyboard(id) });
    rememberPending(id, projectPath, chatId, sent.message_id);
    console.info("[push:preview]", { id, projectPath, branch: preview.branch, ahead: preview.ahead, behind: preview.behind });
  });

  bot.callbackQuery(/^pi:push:(confirm|cancel):([a-f0-9]+)$/u, async (ctx) => {
    const match = ctx.callbackQuery?.data?.match(/^pi:push:(confirm|cancel):([a-f0-9]+)$/u);
    if (!match) return;
    const [, action, id] = match;
    const pending = takePending(id);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Esta solicitud de push ya expiró.", show_alert: true }).catch(() => undefined);
      const messageId = getCallbackMessageId(ctx);
      if (ctx.chat?.id !== undefined && messageId !== undefined) {
        await ctx.api
          .editMessageReplyMarkup(ctx.chat.id, messageId, { reply_markup: undefined })
          .catch(() => undefined);
      }
      return;
    }

    if (action === "cancel") {
      await ctx.answerCallbackQuery({ text: "Push cancelado." }).catch(() => undefined);
      await ctx.api
        .editMessageText(pending.chatId, pending.messageId, "❌ Push cancelado.")
        .catch(() => undefined);
      console.info("[push:cancel]", { id, projectPath: pending.projectPath });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Ejecutando push…" }).catch(() => undefined);
    await ctx.api
      .editMessageText(pending.chatId, pending.messageId, "⏳ Ejecutando `git push`…")
      .catch(() => undefined);

    try {
      const { stdout, stderr } = await git(pending.projectPath, ["push"], PUSH_TIMEOUT_MS);
      console.info("[push:ok]", { id, projectPath: pending.projectPath, stdoutLength: stdout.length, stderrLength: stderr.length });
      await ctx.api
        .editMessageText(pending.chatId, pending.messageId, `✅ Push completado en ${pending.projectPath}.`)
        .catch(() => undefined);
      await replyPushResult(ctx, pending.chatId, stdout, stderr);
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string; code?: string | number };
      console.error("[push:error]", {
        id,
        projectPath: pending.projectPath,
        code: err.code,
        message: err.message,
        stdoutLength: err.stdout?.length ?? 0,
        stderrLength: err.stderr?.length ?? 0,
      });
      const reason = err.message ?? "Error desconocido";
      await ctx.api
        .editMessageText(pending.chatId, pending.messageId, `❌ Push falló en ${pending.projectPath}.\n${reason}`)
        .catch(() => undefined);
      await replyPushResult(ctx, pending.chatId, err.stdout ?? "", err.stderr ?? "");
    }
  });
}
