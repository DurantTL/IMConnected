import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, runMigrations } from './db-core.mjs';

// Migrations are bundled into the server build as raw strings.
const files = import.meta.glob('./migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const migrations = Object.entries(files).map(([file, sql]) => ({ name: file.split('/').pop()!, sql }));

let db: DatabaseSync | undefined;

/**
 * The one shared connection. Opened lazily on first use (never while prerendering public pages),
 * with pending migrations applied before it is returned.
 */
export function getDb(): DatabaseSync {
  if (!db) {
    const conn = openDatabase();
    const applied = runMigrations(conn, migrations);
    if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);
    db = conn;
  }
  return db;
}
