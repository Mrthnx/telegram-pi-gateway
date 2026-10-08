import { randomUUID } from "node:crypto";
import { createAgentSession, defineTool, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonStore } from "../persistence/store";
import type { TelegramInteractionBridge } from "../telegram/interactions";

export type PiSessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

type CachedSession = {
  id: string;
  projectPath: string;
  session: PiSessionHandle;
};

export class PiGatewaySessions {
  private readonly cache = new Map<string, CachedSession>();
  private readonly modelRuntimePromise = ModelRuntime.create();

  constructor(private readonly store: JsonStore, private readonly telegramBridge: TelegramInteractionBridge, private readonly piModel?: string) {}

  async get(projectPath: string): Promise<CachedSession> {
    const cached = this.cache.get(projectPath);
    if (cached) return cached;

    const sessions = await this.store.readSessions();
    const existing = sessions.find((item) => item.projectPath === projectPath);
    const id = existing?.sessionId ?? randomUUID();
    const modelRuntime = await this.modelRuntimePromise;
    const model = this.piModel ? resolveModel(modelRuntime, this.piModel) : undefined;
    const { session } = await createAgentSession({
      cwd: projectPath,
      modelRuntime,
      ...(model ? { model } : {}),
      excludeTools: ["ask_user_choice", "ask_user_question"],
      customTools: [createTelegramAskOwnerTool(this.telegramBridge)],
    });
    const handle = { id, projectPath, session };
    this.cache.set(projectPath, handle);
    await this.store.upsertSession(projectPath, id);
    return handle;
  }

  async reset(projectPath: string): Promise<CachedSession> {
    const cached = this.cache.get(projectPath);
    if (cached) cached.session.dispose();
    this.cache.delete(projectPath);
    await this.store.removeSession(projectPath);
    return this.get(projectPath);
  }

  async disposeAll(): Promise<void> {
    for (const cached of this.cache.values()) cached.session.dispose();
    this.cache.clear();
  }
}

function resolveModel(modelRuntime: ModelRuntime, spec: string) {
  const trimmed = spec.trim();
  if (trimmed.includes("/")) {
    const [provider, ...idParts] = trimmed.split("/");
    const id = idParts.join("/");
    const model = modelRuntime.getModel(provider, id);
    if (!model) throw new Error(`Configured Pi model was not found: ${trimmed}`);
    return model;
  }
  throw new Error(`Configured Pi model must be in provider/id format: ${trimmed}`);
}

function createTelegramAskOwnerTool(telegramBridge: TelegramInteractionBridge) {
  return defineTool({
    name: "telegram_ask_owner",
    label: "Ask Telegram Owner",
    description: [
      "Ask the authenticated Telegram owner a bounded question and wait for their answer.",
      "Use this for owner decisions from Telegram, such as permission to push, selecting option A/B/C, or requesting a typed response.",
      "The answer is scoped only to the exact question asked and does not grant global permission.",
      "The question is sent as plain text with numbered options. The owner replies with the number, the option text, or a free-text response.",
    ].join(" "),
    promptSnippet: "Ask the Telegram owner a question with inline buttons or free text, and wait for their reply.",
    promptGuidelines: [
      "This session is running through Telegram, not the local Pi TUI. When you need an interactive user choice, call telegram_ask_owner; never tell the user that the selector is unavailable.",
      "Use telegram_ask_owner when a Telegram-originated workflow needs an explicit owner choice or permission before continuing.",
      "Keep the question concise, provide clear choices when possible, and treat the returned answer as scoped to that exact prompt only.",
    ],
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 2000 }),
      choices: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 8 })),
      allowFreeText: Type.Optional(Type.Boolean()),
    }),
    executionMode: "sequential" as const,
    execute: async (_toolCallId, params, signal) => {
      const answer = await telegramBridge.askOwner(params, signal);
      return {
        content: [{ type: "text", text: `Telegram owner answered: ${answer}` }],
        details: { answer },
      };
    },
  });
}
