import type { SSEEvent, SSEEventType } from '../../types/sse.js';
import type { RunStateSummary } from '../../types/run.js';

interface StreamState {
  seq: number;
}

/**
 * Manages SSE event streams for agent runs.
 * Requirements: 10.2, 14.2, 14.3, 14.5
 */
export class SSEStreamManager {
  private readonly streams = new Map<string, StreamState>();

  /**
   * Creates an SSE event stream for the given runId.
   */
  createStream(runId: string): void {
    this.streams.set(runId, { seq: 0 });
  }

  /**
   * Pushes an event to the stream for the given runId.
   * Auto-assigns incrementing seq, id, and timestamp.
   * Requirements: 10.2, 14.3
   */
  pushEvent(
    runId: string,
    event: Omit<SSEEvent, 'id' | 'seq' | 'timestamp'>,
  ): SSEEvent {
    const stream = this.streams.get(runId) ?? { seq: 0 };
    stream.seq++;
    this.streams.set(runId, stream);

    return {
      id: crypto.randomUUID(),
      seq: stream.seq,
      event: event.event,
      data: event.data,
      timestamp: Date.now(),
    };
  }

  /**
   * Client resubscribes to a run's event stream.
   * Returns a 'state_summary' event with the current run state.
   * Requirements: 14.2, 14.5
   */
  resubscribe(runId: string, stateSummary: RunStateSummary): SSEEvent {
    return this.pushEvent(runId, {
      event: 'state_summary',
      data: stateSummary,
    });
  }

  /**
   * Closes the event stream for the given runId.
   */
  closeStream(runId: string): void {
    this.streams.delete(runId);
  }

  /**
   * Returns the current seq for the given runId (0 if not found).
   * Requirements: 14.3
   */
  getCurrentSeq(runId: string): number {
    return this.streams.get(runId)?.seq ?? 0;
  }
}
