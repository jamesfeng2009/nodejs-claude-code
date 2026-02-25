import type { IdempotencyRecord } from '../../types/idempotency.js';

export type IdempotencyCheckResult =
  | { status: 'new' }
  | { status: 'in_flight' }
  | { status: 'completed'; result: unknown };

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class IdempotencyStore {
  private readonly ttlMs: number;
  private readonly completed = new Map<string, IdempotencyRecord>();
  private readonly inFlight = new Set<string>();
  /** Maps idempotency key → runId for in-flight requests (P0-6 fix) */
  private readonly inFlightRunIds = new Map<string, string>();

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  check(key: string): IdempotencyCheckResult {
    if (!key || key.trim().length === 0) {
      throw new Error('Idempotency key is required');
    }

    const record = this.completed.get(key);
    if (record) {
      return { status: 'completed', result: record.result };
    }

    if (this.inFlight.has(key)) {
      return { status: 'in_flight' };
    }

    this.inFlight.add(key);
    return { status: 'new' };
  }

  /**
   * Associate a runId with an in-flight idempotency key.
   * Allows clients retrying an in-flight request to get the runId for SSE subscription.
   * Fixes P0-6: in_flight response now includes runId.
   */
  setRunId(key: string, runId: string): void {
    this.inFlightRunIds.set(key, runId);
  }

  /**
   * Get the runId associated with an in-flight idempotency key.
   * Returns undefined if not found.
   */
  getRunId(key: string): string | undefined {
    return this.inFlightRunIds.get(key);
  }

  complete(key: string, result: unknown): void {
    const now = Date.now();
    const record: IdempotencyRecord = {
      key,
      prefix: '',
      status: 'completed',
      result,
      createdAt: now,
      completedAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.completed.set(key, record);
    this.inFlight.delete(key);
    this.inFlightRunIds.delete(key);
  }

  fail(key: string): void {
    this.inFlight.delete(key);
    this.inFlightRunIds.delete(key);
  }

  cleanExpired(): void {
    const now = Date.now();
    for (const [key, record] of this.completed) {
      if (record.expiresAt < now) {
        this.completed.delete(key);
      }
    }
  }
}
