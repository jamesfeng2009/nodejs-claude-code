import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface RollbackSnapshot {
  filePath: string;
  /** Original file content before transaction; null if file did not exist */
  originalContent: string | null;
}

export interface TransactionReport {
  transactionId: string;
  status: 'committed' | 'rolled_back';
  files: Array<{
    filePath: string;
    action: 'written' | 'restored' | 'deleted';
    error?: string;
  }>;
}

interface TransactionState {
  snapshots: Map<string, string | null>;
  writtenFiles: string[];
  status: 'active' | 'committed' | 'rolled_back';
  writeErrors: Map<string, Error>;
}

export class TransactionManager {
  private transactions = new Map<string, TransactionState>();
  private activeTransactionId: string | null = null;

  /**
   * Begin a new atomic transaction. Returns the transaction ID.
   * Throws if an active transaction already exists.
   */
  beginTransaction(): string {
    if (this.activeTransactionId !== null) {
      throw new Error(`已有活跃事务 ${this.activeTransactionId}，请先提交或回滚`);
    }

    const transactionId = crypto.randomUUID();
    this.transactions.set(transactionId, {
      snapshots: new Map(),
      writtenFiles: [],
      status: 'active',
      writeErrors: new Map(),
    });
    this.activeTransactionId = transactionId;
    return transactionId;
  }

  /**
   * Write a file within a transaction.
   * Captures a RollbackSnapshot on the first write to each file.
   */
  async writeFile(transactionId: string, filePath: string, content: string): Promise<void> {
    const tx = this.getTransaction(transactionId);

    // Capture snapshot on first write to this file
    if (!tx.snapshots.has(filePath)) {
      const originalContent = existsSync(filePath)
        ? readFileSync(filePath, 'utf-8')
        : null;
      tx.snapshots.set(filePath, originalContent);
      tx.writtenFiles.push(filePath);
    }

    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, 'utf-8');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      tx.writeErrors.set(filePath, error);
      throw error;
    }
  }

  /**
   * Commit the transaction. If any writes failed, auto-triggers rollback instead.
   */
  async commitTransaction(transactionId: string): Promise<TransactionReport> {
    const tx = this.getTransaction(transactionId);

    if (tx.writeErrors.size > 0) {
      // Auto-rollback on write failures
      return this.rollbackTransaction(transactionId);
    }

    tx.status = 'committed';
    this.activeTransactionId = null;

    const report: TransactionReport = {
      transactionId,
      status: 'committed',
      files: tx.writtenFiles.map((filePath) => ({
        filePath,
        action: 'written' as const,
      })),
    };

    // Discard snapshots
    this.transactions.delete(transactionId);

    return report;
  }

  /**
   * Rollback the transaction, restoring all modified files in reverse order.
   */
  async rollbackTransaction(transactionId: string): Promise<TransactionReport> {
    const tx = this.getTransaction(transactionId);

    tx.status = 'rolled_back';
    this.activeTransactionId = null;

    const fileReports: TransactionReport['files'] = [];

    // Restore in reverse order of writes
    const reversedFiles = [...tx.writtenFiles].reverse();

    for (const filePath of reversedFiles) {
      const originalContent = tx.snapshots.get(filePath);

      try {
        if (originalContent === null) {
          // File didn't exist before transaction — delete it
          if (existsSync(filePath)) {
            unlinkSync(filePath);
          }
          fileReports.push({ filePath, action: 'deleted' });
        } else {
          // Restore original content
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, originalContent, 'utf-8');
          fileReports.push({ filePath, action: 'restored' });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fileReports.push({
          filePath,
          action: originalContent === null ? 'deleted' : 'restored',
          error: message,
        });
        // Continue restoring remaining files
      }
    }

    this.transactions.delete(transactionId);

    return {
      transactionId,
      status: 'rolled_back',
      files: fileReports,
    };
  }

  /**
   * Auto-rollback any active transaction (called on session end).
   */
  async cleanupOpenTransactions(): Promise<void> {
    if (this.activeTransactionId !== null) {
      const id = this.activeTransactionId;
      console.warn(`[TransactionManager] Warning: auto-rolling back open transaction ${id}`);
      await this.rollbackTransaction(id);
    }
  }

  /** Returns the current active transaction ID, or null if none. */
  getActiveTransactionId(): string | null {
    return this.activeTransactionId;
  }

  private getTransaction(transactionId: string): TransactionState {
    const tx = this.transactions.get(transactionId);
    if (!tx) {
      throw new Error(`事务 ${transactionId} 不存在`);
    }
    return tx;
  }
}
