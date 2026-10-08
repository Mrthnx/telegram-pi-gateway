import { randomUUID } from "node:crypto";
import { InlineKeyboard, type Context } from "grammy";

type TelegramApi = Context["api"];

const QUESTION_TIMEOUT_MS = 15 * 60 * 1000;

type PendingQuestion = {
  id: string;
  chatId: number | string;
  messageId: number;
  choices: string[];
  allowFreeText: boolean;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

export type OwnerQuestionParams = {
  question: string;
  choices?: string[];
  allowFreeText?: boolean;
};

export class TelegramInteractionBridge {
  private api?: TelegramApi;
  private activeChatId?: number | string;
  private pending?: PendingQuestion;

  bindBot(): void {
    // No-op; api is bound via bindOwnerChat on each interaction.
  }

  bindOwnerChat(ctx: Context): void {
    if (!ctx.chat?.id) return;
    this.activeChatId = ctx.chat.id;
    this.api = ctx.api;
  }

  hasPendingQuestion(): boolean {
    return Boolean(this.pending);
  }

  async askOwner(params: OwnerQuestionParams, signal?: AbortSignal): Promise<string> {
    if (!this.api || !this.activeChatId) {
      throw new Error("No active Telegram owner chat is available for this Pi session.");
    }
    if (this.pending) {
      throw new Error("Another Telegram owner question is already pending.");
    }

    const question = params.question.trim();
    if (!question) throw new Error("Question must not be empty.");

    const choices = normalizeChoices(params.choices);
    const allowFreeText = params.allowFreeText ?? choices.length === 0;
    if (choices.length === 0 && !allowFreeText) {
      throw new Error("Provide at least one choice or allow free-text answers.");
    }

    const id = randomUUID().slice(0, 12);
    const keyboard = buildKeyboard(id, choices, allowFreeText);
    const suffix = allowFreeText
      ? "\n\nElegí una opción o escribí tu respuesta."
      : "\n\nElegí una opción.";
    const sent = await this.api.sendMessage(this.activeChatId, `${question}${suffix}`, {
      reply_markup: keyboard,
    });

    console.info("[telegram-question:sent]", {
      id,
      chatId: sent.chat.id,
      messageId: sent.message_id,
      choices,
      allowFreeText,
      questionPreview: previewText(question),
    });

    return new Promise<string>((resolve, reject) => {
      const abort = () => {
        if (this.pending?.id !== id) return;
        this.pending = undefined;
        cleanup();
        console.info("[telegram-question:aborted]", { id });
        reject(new Error("Telegram owner question was aborted."));
      };
      signal?.addEventListener("abort", abort, { once: true });

      const expire = () => {
        if (this.pending?.id !== id) return;
        this.pending = undefined;
        cleanup();
        console.info("[telegram-question:expired]", { id });
        void this.api?.editMessageText(sent.chat.id, sent.message_id, "Pregunta expirada. Volvé a pedirla si todavía hace falta.").catch(() => undefined);
        reject(new Error("Telegram owner question expired."));
      };
      const timeout = setTimeout(expire, QUESTION_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      };
      this.pending = {
        id,
        chatId: this.activeChatId!,
        messageId: sent.message_id,
        choices,
        allowFreeText,
        timeout,
        resolve: (answer) => {
          cleanup();
          resolve(answer);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        cleanup,
      };
    });
  }

  async handleChoiceCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data;
    const match = data?.match(/^pi:(answer|free-text):([^:]+)(?::(\d+))?$/u);
    if (!match) return false;

    const [, kind, questionId, choiceIndex] = match;
    const pending = this.pending;
    console.info("[telegram-question:callback]", {
      data,
      kind,
      questionId,
      choiceIndex,
      hasPending: Boolean(pending),
      pendingId: pending?.id,
    });

    if (!pending || pending.id !== questionId) {
      await ctx.answerCallbackQuery({ text: "Esta pregunta ya no está activa.", show_alert: true }).catch(() => undefined);
      return true;
    }

    if (kind === "free-text") {
      await ctx.answerCallbackQuery({ text: "Respondé escribiendo tu texto en este chat.", show_alert: true }).catch(() => undefined);
      return true;
    }

    const choice = pending.choices[Number(choiceIndex)];
    if (!choice) {
      await ctx.answerCallbackQuery({ text: "Opción inválida.", show_alert: true }).catch(() => undefined);
      return true;
    }

    await ctx.answerCallbackQuery({ text: "Respuesta enviada." }).catch(() => undefined);
    await this.finishPending(choice, ctx);
    return true;
  }

  async tryResolveText(ctx: Context, text: string): Promise<boolean> {
    const pending = this.pending;
    if (!pending) return false;

    if (!pending.allowFreeText) {
      await ctx.reply("Hay una pregunta pendiente. Elegí una de las opciones con los botones.");
      return true;
    }

    const answer = text.trim();
    if (!answer) return true;
    await this.finishPending(answer, ctx);
    return true;
  }

  private async finishPending(answer: string, ctx: Context): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      console.warn("[telegram-question:finish-without-pending]", { answerPreview: previewText(answer) });
      return;
    }
    this.pending = undefined;

    console.info("[telegram-question:resolving]", {
      id: pending.id,
      answerPreview: previewText(answer),
    });

    try {
      await ctx.api.editMessageText(pending.chatId, pending.messageId, `✅ Respondido: ${answer}`);
    } catch {
      // Best-effort cleanup only; the resolved answer is the durable outcome.
    }

    pending.resolve(answer);
    console.info("[telegram-question:resolved]", { id: pending.id });
  }
}

function normalizeChoices(choices: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const choice of choices ?? []) {
    const value = choice.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized.slice(0, 8);
}

function buildKeyboard(id: string, choices: string[], allowFreeText: boolean): InlineKeyboard | undefined {
  if (choices.length === 0 && !allowFreeText) return undefined;

  const keyboard = new InlineKeyboard();
  for (const [index, choice] of choices.entries()) {
    keyboard.text(choice.slice(0, 64), `pi:answer:${id}:${index}`).row();
  }
  if (allowFreeText) keyboard.text("✍️ Escribir respuesta", `pi:free-text:${id}`).row();
  return keyboard;
}

function previewText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 200);
}
