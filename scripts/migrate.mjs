#!/usr/bin/env node
// Create the database in DATA_DIR if needed and apply pending migrations. Run before the server starts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const db = openDatabase();
const applied = runMigrations(db, readMigrationsFromDir(path.join(here, '../src/lib/db/migrations')));
console.log(applied.length ? `[db] applied migrations: ${applied.join(', ')}` : '[db] up to date');
db.close();
