import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../src/session/session-store.js';
import type { Session } from '../../src/types/session.js';

// Feature: nodejs-claude-code, Property 46: 会话持久化往返一致性
// For any session, save(session) then load(sessionId) returns a session deeply equal to the original.
// Validates: Requirements 11.1, 11.5

// Feature: nodejs-claude-code, Property 47: 会话 ID 唯一性
// Creating N sessions always produces N distinct sessionIds.
// Validates: Requirements 11.3

// Feature: nodejs-claude-code, Property 48: 会话列表完整性
// After saving N sessions, list() returns at least N entries (all saved sessions appear).
// Validates: Requirements 11.2

// Feature: nodejs-claude-code, Property 49: 过期会话自动清理
// Sessions with updatedAt older than maxAgeDays are removed by cleanExpired().
// Sessions within the age limit are preserved.
// Validates: Requirements 11.4

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return join(tmpdir(), `test-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Arbitraries ────────────────────────────────────────────────────────────

const messageArb = fc.record({
  role: fc.constantFrom('user', 'assistant', 'system', 'tool') as fc.Arbitrary<
    'user' | 'assistant' | 'system' | 'tool'
  >,
  content: fc.string({ minLength: 0, maxLength: 200 }),
  timestamp: fc.integer({ min: 0, max: 2_000_000_000_000 }),
});

const entityReferenceArb = fc.record({
  type: fc.constantFrom(
    'file_path',
    'function_name',
    'variable_name',
    'error_code',
    'class_name'
  ) as fc.Arbitrary<'file_path' | 'function_name' | 'variable_name' | 'error_code' | 'class_name'>,
  value: fc.string({ minLength: 1, maxLength: 100 }),
  lastMentionedTurn: fc.integer({ min: 0, max: 1000 }),
});

const toolCallRecordArb = fc.record({
  toolCallId: fc.string({ minLength: 1, maxLength: 50 }),
  toolName: fc.string({ minLength: 1, maxLength: 50 }),
  args: fc.dictionary(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.oneof(fc.string(), fc.integer(), fc.boolean()),
    { minKeys: 0, maxKeys: 5 }
  ) as fc.Arbitrary<Record<string, unknown>>,
  result: fc.record({
    toolCallId: fc.string({ minLength: 1, maxLength: 50 }),
    content: fc.string({ minLength: 0, maxLength: 200 }),
    isError: fc.boolean(),
  }),
  timestamp: fc.integer({ min: 0, max: 2_000_000_000_000 }),
});

const sessionArb: fc.Arbitrary<Session> = fc.record({
  sessionId: fc.uuid(),
  createdAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  updatedAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  conversationHistory: fc.array(messageArb, { minLength: 0, maxLength: 10 }),
  keyEntityCache: fc.array(entityReferenceArb, { minLength: 0, maxLength: 5 }),
  toolCallRecords: fc.array(toolCallRecordArb, { minLength: 0, maxLength: 5 }),
  metadata: fc.dictionary(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.oneof(fc.string(), fc.integer(), fc.boolean()),
    { minKeys: 0, maxKeys: 5 }
  ) as fc.Arbitrary<Record<string, unknown>>,
});

// ─── Property 46: 会话持久化往返一致性 ──────────────────────────────────────

describe('Property 46: 会话持久化往返一致性', () => {
  it('save then load returns deeply equal session', async () => {
    await fc.assert(
      fc.asyncProperty(sessionArb, async (session) => {
        const workDir = makeTempDir();
        tempDirs.push(workDir);
        const store = new SessionStore(workDir);

        await store.save(session);
        const loaded = await store.load(session.sessionId);

        expect(loaded).toEqual(session);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 47: 会话 ID 唯一性 ────────────────────────────────────────────

describe('Property 47: 会话 ID 唯一性', () => {
  it('creating N sessions produces N distinct sessionIds', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        const workDir = makeTempDir();
        tempDirs.push(workDir);
        const store = new SessionStore(workDir);

        const ids = Array.from({ length: n }, () => store.create().sessionId);
        const unique = new Set(ids);

        expect(unique.size).toBe(n);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 48: 会话列表完整性 ────────────────────────────────────────────

describe('Property 48: 会话列表完整性', () => {
  it('after saving N sessions, list() contains all saved sessionIds', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(sessionArb, { minLength: 1, maxLength: 10 }),
        async (sessions) => {
          const workDir = makeTempDir();
          tempDirs.push(workDir);
          const store = new SessionStore(workDir);

          // Ensure unique sessionIds (the arbitrary may produce duplicates)
          const unique = new Map<string, Session>();
          for (const s of sessions) unique.set(s.sessionId, s);
          const uniqueSessions = [...unique.values()];

          for (const s of uniqueSessions) {
            await store.save(s);
          }

          const listed = await store.list();
          const listedIds = new Set(listed.map((s) => s.sessionId));

          for (const s of uniqueSessions) {
            expect(listedIds.has(s.sessionId)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 49: 过期会话自动清理 ──────────────────────────────────────────

describe('Property 49: 过期会话自动清理', () => {
  it('cleanExpired removes old sessions and preserves recent ones', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 60 }),
        async (numExpired, numFresh, maxAgeDays) => {
          const workDir = makeTempDir();
          tempDirs.push(workDir);
          const store = new SessionStore(workDir);

          const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

          // Create expired sessions (updatedAt well before cutoff)
          const expiredSessions: Session[] = Array.from({ length: numExpired }, () => ({
            ...store.create(),
            updatedAt: cutoff - 24 * 60 * 60 * 1000, // 1 day before cutoff
          }));

          // Create fresh sessions (updatedAt after cutoff)
          const freshSessions: Session[] = Array.from({ length: numFresh }, () => ({
            ...store.create(),
            updatedAt: Date.now(),
          }));

          for (const s of [...expiredSessions, ...freshSessions]) {
            await store.save(s);
          }

          await store.cleanExpired(maxAgeDays);

          const listed = await store.list();
          const listedIds = new Set(listed.map((s) => s.sessionId));

          // All fresh sessions must still be present
          for (const s of freshSessions) {
            expect(listedIds.has(s.sessionId)).toBe(true);
          }

          // All expired sessions must be gone
          for (const s of expiredSessions) {
            expect(listedIds.has(s.sessionId)).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
