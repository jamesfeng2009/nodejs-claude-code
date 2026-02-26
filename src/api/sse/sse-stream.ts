import { randomUUID } from 'crypto';
import type { ServerResponse } from 'http';
import type { SSEEvent } from '../../types/sse.js';
import type { RunStateSummary } from '../../types/run.js';

interface StreamState {
  seq: number;
  subscribers: Set<ServerResponse>;
}

/**
 * Manages SSE event streams for agent runs.
 * Maintains runId → subscribers so pushEvent() writes to live HTTP connections.
 * Requirements: 10.2, 14.2, 14.3, 14.5
 */
export class SSEStreamManager {
  private readonly streams = new Map<string, StreamState>();

  /**
   * Creates an SSE event stream for the given runId.
   */
  createStream(runId: string): void {
    if (!this.streams.has(runId)) {
      this.streams.set(runId, { seq: 0, subscribers: new Set() });
    }
  }

  /**
   * Subscribes a ServerResponse to the stream for the given runId.
   * Cleans up on connection close.
   * Requirements: 14.2
   */
  subscribe(runId: string, res: ServerResponse): void {
    const stream = this.streams.get(runId);
    if (!stream) return;
    stream.subscribers.add(res);
    res.once('close', () => {
      stream.subscribers.delete(res);
    });
  }

  /**
   * Pushes an event to all subscribers of the given runId.
   * Auto-assigns incrementing seq, id, and timestamp.
   * Requirements: 10.2, 14.3
   */
  pushEvent(
    runId: string,
    event: Omit<SSEEvent, 'id' | 'seq' | 'timestamp'>,
  ): SSEEvent {
    const stream = this.streams.get(runId) ?? { seq: 0, subscribers: new Set<ServerResponse>() };
    stream.seq++;
    this.streams.set(runId, stream);

    const sseEvent: SSEEvent = {
      id: randomUUID(),
      seq: stream.seq,
      event: event.event,
      data: event.data,
      timestamp: Date.now(),
    };

    const formatted = this.formatEvent(sseEvent);
    for (const res of stream.subscribers) {
      try {
        res.write(formatted);
      } catch {
        stream.subscribers.delete(res);
      }
    }

    return sseEvent;
  }

  /**
   * Client resubscribes to a run's event stream.
   * Pushes a 'state_summary' event immediately, then keeps the connection open.
   * Requirements: 14.2, 14.5
   */
  resubscribe(runId: string, res: ServerResponse, stateSummary: RunStateSummary): void {
    this.subscribe(runId, res);
    this.pushEvent(runId, {
      event: 'state_summary',
      data: stateSummary,
    });
  }

  /**
   * Closes all subscriber connections for the given runId and removes the stream.
   */
  closeStream(runId: string): void {
    const stream = this.streams.get(runId);
    if (stream) {
      for (const res of stream.subscribers) {
        try {
          res.end();
        } catch {
          // already closed
        }
      }
      stream.subscribers.clear();
    }
    this.streams.delete(runId);
  }

  /**
   * Returns the current seq for the given runId (0 if not found).
   * Requirements: 14.3
   */
  getCurrentSeq(runId: string): number {
    return this.streams.get(runId)?.seq ?? 0;
  }

  private formatEvent(event: SSEEvent): string {
    const dataPayload: Record<string, unknown> = {
      seq: event.seq,
      timestamp: event.timestamp,
    };
    // Safely merge event.data only if it's a plain object
    if (event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data)) {
      Object.assign(dataPayload, event.data);
    } else if (event.data !== undefined) {
      dataPayload['data'] = event.data;
    }
    return [
      `id: ${event.id}`,
      `event: ${event.event}`,
      `data: ${JSON.stringify(dataPayload)}`,
      '',
      '',
    ].join('\n');
  }
}
