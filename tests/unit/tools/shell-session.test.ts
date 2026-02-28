import { describe, it, expect, afterEach } from 'vitest';
import { ShellSessionManager } from '../../../src/tools/implementations/shell-session.js';

describe('ShellSessionManager', () => {
  let manager: ShellSessionManager;

  afterEach(() => {
    manager.destroyAll();
  });

  // ── Timeout trigger ──────────────────────────────────────────────────────────

  describe('timeout', () => {
    it('resolves with a "timed out" message when command exceeds timeoutMs', async () => {
      manager = new ShellSessionManager();
      const result = await manager.execute('session-timeout', 'sleep 5', 100);
      expect(result).toMatch(/timed out/i);
    });

    it('includes the timeout duration in the message', async () => {
      manager = new ShellSessionManager();
      const result = await manager.execute('session-timeout-2', 'sleep 5', 150);
      expect(result).toContain('150');
    });
  });

  // ── Transparent restart after unexpected exit ────────────────────────────────

  describe('transparent restart after unexpected shell exit', () => {
    it('creates a new shell process and succeeds after the previous process is killed', async () => {
      manager = new ShellSessionManager();
      const sessionId = 'session-restart';

      // Establish the session with a simple command
      const first = await manager.execute(sessionId, 'echo hello', 5000);
      expect(first).toContain('hello');

      // Grab the underlying process and kill it externally
      const session = manager.getOrCreate(sessionId);
      session.process.kill('SIGKILL');

      // Give the exit event a moment to propagate
      await new Promise(resolve => setTimeout(resolve, 100));

      // Next execute() should transparently restart and succeed
      const second = await manager.execute(sessionId, 'echo world', 5000);
      expect(second).toContain('world');
    });

    it('new session after restart has a fresh process', async () => {
      manager = new ShellSessionManager();
      const sessionId = 'session-restart-2';

      const s1 = manager.getOrCreate(sessionId);
      const pid1 = s1.process.pid;

      s1.process.kill('SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 100));

      // Trigger transparent restart via execute
      await manager.execute(sessionId, 'echo ok', 5000);

      const s2 = manager.getOrCreate(sessionId);
      expect(s2.process.pid).not.toBe(pid1);
    });
  });

  // ── destroyAll() ─────────────────────────────────────────────────────────────

  describe('destroyAll()', () => {
    it('terminates all active sessions', async () => {
      manager = new ShellSessionManager();

      // Create two sessions
      await manager.execute('s1', 'echo a', 5000);
      await manager.execute('s2', 'echo b', 5000);

      const proc1 = manager.getOrCreate('s1').process;
      const proc2 = manager.getOrCreate('s2').process;

      manager.destroyAll();

      // After destroyAll, both processes should be killed (killed flag or exitCode set)
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(proc1.killed || proc1.exitCode !== null).toBe(true);
      expect(proc2.killed || proc2.exitCode !== null).toBe(true);
    });

    it('creates fresh sessions after destroyAll', async () => {
      manager = new ShellSessionManager();

      await manager.execute('s3', 'echo hi', 5000);
      const oldPid = manager.getOrCreate('s3').process.pid;

      manager.destroyAll();

      // After destroyAll, getOrCreate should spawn a new process
      const newSession = manager.getOrCreate('s3');
      expect(newSession.process.pid).not.toBe(oldPid);

      // Clean up the newly created session
    });
  });

  // ── destroy(sessionId) ───────────────────────────────────────────────────────

  describe('destroy(sessionId)', () => {
    it('terminates the specific session process', async () => {
      manager = new ShellSessionManager();

      await manager.execute('target', 'echo target', 5000);
      const proc = manager.getOrCreate('target').process;

      manager.destroy('target');

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(proc.killed || proc.exitCode !== null).toBe(true);
    });

    it('does not affect other sessions', async () => {
      manager = new ShellSessionManager();

      await manager.execute('keep', 'echo keep', 5000);
      await manager.execute('remove', 'echo remove', 5000);

      const keepProc = manager.getOrCreate('keep').process;

      manager.destroy('remove');

      // The 'keep' session should still be alive and functional
      const result = await manager.execute('keep', 'echo still-alive', 5000);
      expect(result).toContain('still-alive');
      expect(keepProc.killed).toBe(false);
    });

    it('is a no-op when sessionId does not exist', () => {
      manager = new ShellSessionManager();
      // Should not throw
      expect(() => manager.destroy('nonexistent')).not.toThrow();
    });

    it('creates a new session after destroy when execute is called again', async () => {
      manager = new ShellSessionManager();

      await manager.execute('reuse', 'echo first', 5000);
      const oldPid = manager.getOrCreate('reuse').process.pid;

      manager.destroy('reuse');

      const result = await manager.execute('reuse', 'echo second', 5000);
      expect(result).toContain('second');

      const newPid = manager.getOrCreate('reuse').process.pid;
      expect(newPid).not.toBe(oldPid);
    });
  });
});
