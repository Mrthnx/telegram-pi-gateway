import { randomUUID } from "node:crypto";
import { createAgentSession, defineTool, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonStore } from "../persistence/store";
import type { TelegramInteractionBridge } from "../telegram/interactions";
import { parseModelSpec } from "./model-spec";

export type PiSessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

type CachedSession = {
  id: string;
  projectPath: string;
  session: PiSessionHandle;
};

export class PiGatewaySessions {
  private readonly cache = new Map<string, CachedSession>();
  private readonly modelRuntimePromise = ModelRuntime.create();

  constructor(
    private readonly store: JsonStore,
    private readonly telegramBridge: TelegramInteractionBridge,
    private readonly options: { piModel?: string | undefined; dataDir?: string | undefined },
  ) {}

  async get(projectPath: string): Promise<CachedSession> {
    const cached = this.cache.get(projectPath);
    if (cached) return cached;

    const sessions = await this.store.readSessions();
    const existing = sessions.find((item) => item.projectPath === projectPath);
    const id = existing?.sessionId ?? randomUUID();
    const modelRuntime = await this.modelRuntimePromise;
    const model = this.options.piModel ? resolveModel(modelRuntime, this.options.piModel) : undefined;
    const { session } = await createAgentSession({
      cwd: projectPath,
      modelRuntime,
      ...(model ? { model } : {}),
      excludeTools: ["ask_user_choice", "ask_user_question"],
      customTools: [
        createTelegramAskOwnerTool(this.telegramBridge),
        createTelegramSendMediaTool(this.telegramBridge, projectPath, this.options.dataDir),
      ],
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
  const { provider, id } = parseModelSpec(spec);
  const model = modelRuntime.getModel(provider, id);
  if (!model) throw new Error(`Configured Pi model was not found: ${spec.trim()}`);
  return model;
}

function createTelegramSendMediaTool(telegramBridge: TelegramInteractionBridge, projectPath: string, dataDir?: string | undefined) {
  const allowedRoots = dataDir ? [projectPath, dataDir] : [projectPath];
  return defineTool({
    name: "telegram_send_media",
    label: "Send Media To Telegram",
    description: [
      "Send a local file to the Telegram owner as a photo, a document or a voice note.",
      "Use this whenever the owner asks for a file back: an image you generated or edited, a screenshot, a report, an audio clip.",
      "The file must live inside the active project or inside the gateway data directory.",
      "Voice notes are only delivered as playable voice messages for .ogg, .oga, .mp3 and .m4a files; any other audio is delivered as a document.",
    ].join(" "),
    promptSnippet: "Send a local file to the Telegram owner as a photo, a document or a voice note.",
    promptGuidelines: [
      "This session is running through Telegram. When the owner asks for a file back, call telegram_send_media instead of only printing its path.",
      "Write the file first, then send it. Do not send a file you did not create or verify.",
      "Keep the caption short; it is shown under the media in the chat.",
    ],
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      caption: Type.Optional(Type.String({ maxLength: 1024 })),
      kind: Type.Optional(Type.Union([Type.Literal("photo"), Type.Literal("document"), Type.Literal("voice")])),
    }),
    executionMode: "sequential" as const,
    execute: async (_toolCallId, params) => {
      const result = await telegramBridge.sendMedia(
        { path: params.path, caption: params.caption, kind: params.kind },
        { baseDir: projectPath, allowedRoots },
      );
      return {
        content: [{ type: "text", text: `Sent ${result.kind} to the Telegram owner: ${result.path}` }],
        details: result,
      };
    },
  });
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
