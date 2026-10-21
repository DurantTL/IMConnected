#!/usr/bin/env node
// Part of `npm run build`: after Pagefind has indexed dist/client, delete the build-time-only search source pages
// (src/pages/search-source/) so the server doesn't serve them. The index keeps what it needs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'dist/client/search-source');
if (!dir.startsWith(path.join(root, 'dist') + path.sep)) throw new Error('unexpected path');
fs.rmSync(dir, { recursive: true, force: true });
