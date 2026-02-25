export interface IdempotencyRecord {
  key: string;
  prefix: string;
  status: 'in_flight' | 'completed';
  result?: unknown;
  createdAt: number;
  completedAt?: number;
  expiresAt: number;
}
