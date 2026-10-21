import type { DriveClient } from './gdrive.mjs';
export const backupsDir: (dataDir: string) => string;
export function pruneLocal(dataDir: string, today: string): string[];
export function listLocal(dataDir: string): { name: string; bytes: number }[];
export interface BackupPartial { dbBytes: number | null; mediaBytes: number | null; uploads: number; attempts: number }
export function performBackup(opts: {
  dataDir: string;
  drive: DriveClient | null;
  now?: number;
  maxAttempts?: number;
  attemptDelayMs?: number;
  secrets?: string[];
}): Promise<{ day: string; dbBytes: number; mediaBytes: number; uploads: number; attempts: number; warnings: string[] }>;
