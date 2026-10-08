import { randomUUID } from "node:crypto";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { JsonStore } from "../persistence/store";

export type PiSessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

type CachedSession = {
  id: string;
  projectPath: string;
  session: PiSessionHandle;
};

export class PiGatewaySessions {
  private readonly cache = new Map<string, CachedSession>();

  constructor(private readonly store: JsonStore) {}

  async get(projectPath: string): Promise<CachedSession> {
    const cached = this.cache.get(projectPath);
    if (cached) return cached;

    const sessions = await this.store.readSessions();
    const existing = sessions.find((item) => item.projectPath === projectPath);
    const id = existing?.sessionId ?? randomUUID();
    const { session } = await createAgentSession({ cwd: projectPath });
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
