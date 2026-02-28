import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';

export interface ShellSession {
  sessionId: string;
  process: ChildProcess;
  createdAt: number;
}

export class ShellSessionManager {
  private sessions = new Map<string, ShellSession>();
  // Per-session mutex: each entry is a promise chain for serializing commands
  private executionQueues = new Map<string, Promise<string>>();

  getOrCreate(sessionId: string): ShellSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    return this._create(sessionId);
  }

  private _create(sessionId: string): ShellSession {
    const proc = spawn('bash', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const session: ShellSession = {
      sessionId,
      process: proc,
      createdAt: Date.now(),
    };

    // On unexpected exit, remove from map so next call transparently restarts
    proc.on('exit', () => {
      const current = this.sessions.get(sessionId);
      if (current && current.process === proc) {
        this.sessions.delete(sessionId);
      }
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  async execute(sessionId: string, command: string, timeoutMs: number): Promise<string> {
    // Serialize commands per session to prevent stdout/stderr interleaving
    const prev = this.executionQueues.get(sessionId) ?? Promise.resolve('');
    const next = prev.then(() => this._executeOne(sessionId, command, timeoutMs));
    // Store the chain but don't let rejections propagate to the queue itself
    this.executionQueues.set(sessionId, next.catch(() => ''));
    return next;
  }

  private _executeOne(sessionId: string, command: string, timeoutMs: number): Promise<string> {
    // Transparently restart if shell died
    const session = this.getOrCreate(sessionId);

    const sentinel = `__KIRO_DONE_${randomUUID()}__`;
    const input = `${command}\necho '${sentinel}'\n`;

    return new Promise<string>((resolve) => {
      const proc = session.process;
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let settled = false;

      const cleanup = () => {
        proc.stdout?.removeListener('data', onStdout);
        proc.stderr?.removeListener('data', onStderr);
        proc.removeListener('exit', onExit);
        clearTimeout(timer);
      };

      const settle = (result: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const timer = setTimeout(() => {
        // Send Ctrl-C to interrupt the running command
        try {
          proc.stdin?.write('\x03');
        } catch {
          // ignore write errors
        }
        settle(`Command timed out after ${timeoutMs}ms`);
      }, timeoutMs);

      const onStdout = (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const sentinelIndex = stdoutBuffer.indexOf(sentinel);
        if (sentinelIndex !== -1) {
          // Extract output before the sentinel line
          const output = stdoutBuffer.slice(0, sentinelIndex).replace(/\n$/, '');
          const combined = stderrBuffer
            ? `${output}\nstderr:\n${stderrBuffer}`.trim()
            : output;
          settle(combined || '(no output)');
        }
      };

      const onStderr = (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
      };

      const onExit = () => {
        settle(stdoutBuffer.trim() || stderrBuffer.trim() || '(process exited)');
      };

      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', onStderr);
      proc.once('exit', onExit);

      try {
        proc.stdin?.write(input);
      } catch {
        settle('(failed to write to shell process)');
      }
    });
  }

  destroy(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      this.executionQueues.delete(sessionId);
      try {
        session.process.kill();
      } catch {
        // ignore errors when killing already-dead processes
      }
    }
  }

  destroyAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.destroy(sessionId);
    }
  }
}
