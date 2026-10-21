import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, runMigrations, MIGRATION_NAME } from './db-core.mjs';
import { ensureStorySync } from '../story-sync';
import { ensureBackupScheduler } from '../backup';

// Migrations are bundled into the server build as raw strings.
const files = import.meta.glob('./migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const migrations = Object.entries(files).map(([file, sql]) => ({ name: file.split('/').pop()!, sql }))
  .filter((m) => MIGRATION_NAME.test(m.name));

let db: DatabaseSync | undefined;

/**
 * The one shared connection. Opened lazily on first use (never while prerendering public pages),
 * with pending migrations applied before it is returned.
 */
export function getDb(): DatabaseSync {
  if (!db) {
    const conn = openDatabase();
    let applied: string[];
    try {
      applied = runMigrations(conn, migrations);
    } catch (err) {
      conn.close();
      throw err;
    }
    if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);
    db = conn;
  }
  // TEMPORARY (epic #25, until step 4): mirror the built stories into the database in the background.
  // A cheap check after the first pass; never throws and never blocks the caller.
  ensureStorySync();
  // Nightly backups (epic #25, issue #30): starts one unref'd timer when Google Drive is configured; never throws.
  ensureBackupScheduler();
  return db;
}
