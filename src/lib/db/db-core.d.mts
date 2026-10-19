import type { DatabaseSync } from 'node:sqlite';
export function dataDir(): string;
export function openDatabase(dir?: string): DatabaseSync;
export function runMigrations(db: DatabaseSync, migrations: { name: string; sql: string }[]): string[];
export function readMigrationsFromDir(dir: string): { name: string; sql: string }[];
