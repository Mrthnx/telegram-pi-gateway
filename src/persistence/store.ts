import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type GatewayState = {
  activeProjectPath?: string;
  activeSessionId?: string;
  pendingProjectChoices?: ProjectChoice[];
  updatedAt?: string;
};

export type ProjectChoice = {
  name: string;
  path: string;
};

export type ProjectSessionRecord = {
  projectPath: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
};

export class JsonStore {
  constructor(private readonly dataDir: string) {}

  async readState(): Promise<GatewayState> {
    return this.readJson<GatewayState>("state.json", {});
  }

  async writeState(state: GatewayState): Promise<void> {
    await this.writeJson("state.json", { ...state, updatedAt: new Date().toISOString() });
  }

  async readSessions(): Promise<ProjectSessionRecord[]> {
    return this.readJson<ProjectSessionRecord[]>("sessions.json", []);
  }

  async upsertSession(projectPath: string, sessionId: string): Promise<ProjectSessionRecord> {
    const sessions = await this.readSessions();
    const now = new Date().toISOString();
    let record = sessions.find((item) => item.projectPath === projectPath);
    if (!record) {
      record = { projectPath, sessionId, createdAt: now, updatedAt: now };
      sessions.push(record);
    } else {
      record.sessionId = sessionId;
      record.updatedAt = now;
    }
    await this.writeJson("sessions.json", sessions);
    return record;
  }

  async removeSession(projectPath: string): Promise<void> {
    const sessions = (await this.readSessions()).filter((item) => item.projectPath !== projectPath);
    await this.writeJson("sessions.json", sessions);
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      const raw = await readFile(join(this.dataDir, file), "utf8");
      return JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    const target = join(this.dataDir, file);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }
}
