import { DatabaseSync } from 'node:sqlite';
export { DatabaseSync };
export const MIGRATION_NAME: RegExp;
export function dataDir(): string;
export function openDatabase(dir?: string): DatabaseSync;
export function runMigrations(db: DatabaseSync, migrations: { name: string; sql: string }[]): string[];
export function readMigrationsFromDir(dir: string): { name: string; sql: string }[];
export function resetTwoFactor(db: DatabaseSync, userId: number): { authenticators: number; passkeys: number; recoveryCodes: number; oauthLinks: number; sessions: number };
export function allocateUserId(db: DatabaseSync): number;
