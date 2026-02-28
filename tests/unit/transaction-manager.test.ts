import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TransactionManager } from '../../src/tools/implementations/transaction-manager.js';

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tx-manager-test-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('TransactionManager', () => {
  let tm: TransactionManager;
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    tm = new TransactionManager();
    ({ dir, cleanup } = makeTempDir());
  });

  afterEach(() => {
    cleanup();
  });

  // ── beginTransaction ─────────────────────────────────────────────────────────

  describe('beginTransaction', () => {
    it('returns a non-empty string ID', () => {
      const id = tm.beginTransaction();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('returns unique IDs on successive transactions (after commit)', async () => {
      const id1 = tm.beginTransaction();
      await tm.commitTransaction(id1);
      const id2 = tm.beginTransaction();
      expect(id1).not.toBe(id2);
    });

    it('throws when an active transaction already exists', () => {
      tm.beginTransaction();
      expect(() => tm.beginTransaction()).toThrow();
    });

    it('sets the active transaction ID', () => {
      const id = tm.beginTransaction();
      expect(tm.getActiveTransactionId()).toBe(id);
    });
  });

  // ── commitTransaction ────────────────────────────────────────────────────────

  describe('commitTransaction', () => {
    it('persists all file writes after commit', async () => {
      const filePath = join(dir, 'hello.txt');
      const id = tm.beginTransaction();
      await tm.writeFile(id, filePath, 'committed content');
      await tm.commitTransaction(id);

      expect(readFileSync(filePath, 'utf-8')).toBe('committed content');
    });

    it('persists multiple file writes', async () => {
      const file1 = join(dir, 'a.txt');
      const file2 = join(dir, 'b.txt');
      const id = tm.beginTransaction();
      await tm.writeFile(id, file1, 'content-a');
      await tm.writeFile(id, file2, 'content-b');
      await tm.commitTransaction(id);

      expect(readFileSync(file1, 'utf-8')).toBe('content-a');
      expect(readFileSync(file2, 'utf-8')).toBe('content-b');
    });

    it('returns a report with status committed and all written files', async () => {
      const filePath = join(dir, 'file.txt');
      const id = tm.beginTransaction();
      await tm.writeFile(id, filePath, 'data');
      const report = await tm.commitTransaction(id);

      expect(report.status).toBe('committed');
      expect(report.transactionId).toBe(id);
      expect(report.files).toHaveLength(1);
      expect(report.files[0].filePath).toBe(filePath);
      expect(report.files[0].action).toBe('written');
    });

    it('clears the active transaction ID after commit', async () => {
      const id = tm.beginTransaction();
      await tm.commitTransaction(id);
      expect(tm.getActiveTransactionId()).toBeNull();
    });

    it('auto-triggers rollback when a write failed', async () => {
      const existingFile = join(dir, 'existing.txt');
      writeFileSync(existingFile, 'original');

      const newFile = join(dir, 'new.txt');
      const id = tm.beginTransaction();

      // Write the existing file (will be snapshotted)
      await tm.writeFile(id, existingFile, 'modified');

      // Manually inject a write error to simulate a failed write
      const tx = (tm as unknown as { transactions: Map<string, { writeErrors: Map<string, Error> }> }).transactions.get(id)!;
      tx.writeErrors.set(newFile, new Error('simulated write failure'));

      const report = await tm.commitTransaction(id);

      // Should have rolled back
      expect(report.status).toBe('rolled_back');
      // Existing file should be restored to original
      expect(readFileSync(existingFile, 'utf-8')).toBe('original');
    });
  });

  // ── rollbackTransaction ──────────────────────────────────────────────────────

  describe('rollbackTransaction', () => {
    it('restores modified files to their snapshot content', async () => {
      const filePath = join(dir, 'restore-me.txt');
      writeFileSync(filePath, 'before transaction');

      const id = tm.beginTransaction();
      await tm.writeFile(id, filePath, 'during transaction');
      await tm.rollbackTransaction(id);

      expect(readFileSync(filePath, 'utf-8')).toBe('before transaction');
    });

    it('restores multiple files to their respective snapshots', async () => {
      const file1 = join(dir, 'f1.txt');
      const file2 = join(dir, 'f2.txt');
      writeFileSync(file1, 'original-1');
      writeFileSync(file2, 'original-2');

      const id = tm.beginTransaction();
      await tm.writeFile(id, file1, 'modified-1');
      await tm.writeFile(id, file2, 'modified-2');
      await tm.rollbackTransaction(id);

      expect(readFileSync(file1, 'utf-8')).toBe('original-1');
      expect(readFileSync(file2, 'utf-8')).toBe('original-2');
    });

    it('deletes a new file created within the transaction on rollback', async () => {
      const newFile = join(dir, 'brand-new.txt');
      expect(existsSync(newFile)).toBe(false);

      const id = tm.beginTransaction();
      await tm.writeFile(id, newFile, 'new content');
      expect(existsSync(newFile)).toBe(true);

      await tm.rollbackTransaction(id);
      expect(existsSync(newFile)).toBe(false);
    });

    it('returns a report with status rolled_back', async () => {
      const filePath = join(dir, 'file.txt');
      writeFileSync(filePath, 'original');

      const id = tm.beginTransaction();
      await tm.writeFile(id, filePath, 'changed');
      const report = await tm.rollbackTransaction(id);

      expect(report.status).toBe('rolled_back');
      expect(report.transactionId).toBe(id);
    });

    it('rollback report lists all files with their restoration status', async () => {
      const existingFile = join(dir, 'existing.txt');
      const newFile = join(dir, 'new.txt');
      writeFileSync(existingFile, 'original');

      const id = tm.beginTransaction();
      await tm.writeFile(id, existingFile, 'modified');
      await tm.writeFile(id, newFile, 'created');
      const report = await tm.rollbackTransaction(id);

      expect(report.files).toHaveLength(2);
      const existingEntry = report.files.find((f) => f.filePath === existingFile);
      const newEntry = report.files.find((f) => f.filePath === newFile);
      expect(existingEntry?.action).toBe('restored');
      expect(newEntry?.action).toBe('deleted');
    });

    it('clears the active transaction ID after rollback', async () => {
      const id = tm.beginTransaction();
      await tm.rollbackTransaction(id);
      expect(tm.getActiveTransactionId()).toBeNull();
    });

    it('records individual restore failure without stopping remaining restores', async () => {
      // Skip on Windows where chmod doesn't reliably prevent writes
      if (process.platform === 'win32') return;

      const file1 = join(dir, 'protected.txt');
      const file2 = join(dir, 'normal.txt');
      writeFileSync(file1, 'original-1');
      writeFileSync(file2, 'original-2');

      const id = tm.beginTransaction();
      // Write both files so snapshots are captured
      await tm.writeFile(id, file1, 'modified-1');
      await tm.writeFile(id, file2, 'modified-2');

      // Make file1 read-only so restoring it during rollback fails
      chmodSync(file1, 0o444);

      let report: Awaited<ReturnType<typeof tm.rollbackTransaction>>;
      try {
        report = await tm.rollbackTransaction(id);
      } finally {
        // Restore permissions so cleanup can delete the file
        chmodSync(file1, 0o644);
      }

      expect(report.status).toBe('rolled_back');
      // Both files should appear in the report
      expect(report.files).toHaveLength(2);
      // file1 restore should have an error recorded
      const file1Entry = report.files.find((f) => f.filePath === file1);
      expect(file1Entry?.error).toBeDefined();
      // file2 should still be present (rollback continued past the failure)
      const file2Entry = report.files.find((f) => f.filePath === file2);
      expect(file2Entry).toBeDefined();
      // file2 should have been successfully restored
      expect(file2Entry?.error).toBeUndefined();
      expect(readFileSync(file2, 'utf-8')).toBe('original-2');
    });
  });

  // ── cleanupOpenTransactions ──────────────────────────────────────────────────

  describe('cleanupOpenTransactions', () => {
    it('auto-rolls back an open transaction on session end', async () => {
      const filePath = join(dir, 'session-file.txt');
      writeFileSync(filePath, 'before session');

      const id = tm.beginTransaction();
      await tm.writeFile(id, filePath, 'during session');

      // Simulate session end
      await tm.cleanupOpenTransactions();

      // File should be restored
      expect(readFileSync(filePath, 'utf-8')).toBe('before session');
      expect(tm.getActiveTransactionId()).toBeNull();
    });

    it('does nothing when there is no active transaction', async () => {
      // Should not throw
      await expect(tm.cleanupOpenTransactions()).resolves.toBeUndefined();
      expect(tm.getActiveTransactionId()).toBeNull();
    });

    it('allows a new transaction to begin after cleanup', async () => {
      const id1 = tm.beginTransaction();
      await tm.writeFile(id1, join(dir, 'tmp.txt'), 'data');
      await tm.cleanupOpenTransactions();

      // Should be able to start a new transaction
      const id2 = tm.beginTransaction();
      expect(id2).toBeTruthy();
      await tm.commitTransaction(id2);
    });
  });

  // ── getActiveTransactionId ───────────────────────────────────────────────────

  describe('getActiveTransactionId', () => {
    it('returns null when no transaction is active', () => {
      expect(tm.getActiveTransactionId()).toBeNull();
    });

    it('returns the active transaction ID while a transaction is open', () => {
      const id = tm.beginTransaction();
      expect(tm.getActiveTransactionId()).toBe(id);
    });

    it('returns null after commit', async () => {
      const id = tm.beginTransaction();
      await tm.commitTransaction(id);
      expect(tm.getActiveTransactionId()).toBeNull();
    });

    it('returns null after rollback', async () => {
      const id = tm.beginTransaction();
      await tm.rollbackTransaction(id);
      expect(tm.getActiveTransactionId()).toBeNull();
    });
  });
});
