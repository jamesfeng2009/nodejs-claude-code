import { mkdir, readFile, writeFile, unlink, readdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { Session, SessionSummary } from '../types/session.js';

export class SessionStore {
  private readonly sessionsDir: string;

  constructor(workDir: string = process.cwd()) {
    this.sessionsDir = join(workDir, '.ai-assistant', 'sessions');
  }

  /** Creates a new session with a unique sessionId (UUID v4). */
  create(): Session {
    const now = Date.now();
    return {
      sessionId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      conversationHistory: [],
      keyEntityCache: [],
      toolCallRecords: [],
      metadata: {},
    };
  }

  /** Persists a session to .ai-assistant/sessions/{sessionId}.json */
  async save(session: Session): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    const filePath = join(this.sessionsDir, `${session.sessionId}.json`);
    await writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
  }

  /** Loads and parses the session JSON file; throws if not found. */
  async load(sessionId: string): Promise<Session> {
    const filePath = join(this.sessionsDir, `${sessionId}.json`);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return JSON.parse(raw) as Session;
  }

  /** Lists all non-expired sessions from the sessions directory. */
  async list(): Promise<SessionSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionsDir);
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.sessionsDir, entry), 'utf-8');
        const session = JSON.parse(raw) as Session;
        const lastMsg = session.conversationHistory[session.conversationHistory.length - 1];
        summaries.push({
          sessionId: session.sessionId,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.conversationHistory.length,
          lastMessage: lastMsg?.content,
        });
      } catch {
        // skip corrupt files
      }
    }
    return summaries;
  }

  /** Deletes the session file. */
  async delete(sessionId: string): Promise<void> {
    const filePath = join(this.sessionsDir, `${sessionId}.json`);
    await unlink(filePath);
  }

  /**
   * Removes sessions older than maxAgeDays (default 30) based on updatedAt.
   */
  async cleanExpired(maxAgeDays: number = 30): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionsDir);
    } catch {
      return;
    }

    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const filePath = join(this.sessionsDir, entry);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const session = JSON.parse(raw) as Session;
        if (session.updatedAt < cutoff) {
          await unlink(filePath);
        }
      } catch {
        // skip corrupt files
      }
    }
  }
}
