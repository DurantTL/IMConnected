// Exercise the actual adoption/store code with only SQLite and built content redirected to synthetic fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';
const root = process.cwd(), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-section-adoption-'));
const bundle = path.join(root, 'node_modules', `.section-adoption-${process.pid}.mjs`);
process.env.DATA_DIR = scratch;
let db;
try {
  db = openDatabase(scratch); runMigrations(db, readMigrationsFromDir(path.join(root, 'src/lib/db/migrations')));
  globalThis.__sectionAdoptionDb = db;
  await build({ input: 'section-adoption:entry', output: { file: bundle, format: 'esm', codeSplitting: false }, platform: 'node', external: [/^node:/, '@astrojs/markdown-satteri', 'satteri'], plugins: [{
    name: 'synthetic-adoption-inputs',
    resolveId(source) {
      if (source === 'section-adoption:entry') return '\0section-adoption:entry';
      if (/^(?:\.\.\/|\.\/)*(?:lib\/)?db$/.test(source)) return '\0section-adoption:db';
      if (source === 'astro:content') return '\0section-adoption:content';
    },
    load(id) {
      if (id === '\0section-adoption:db') return 'export function getDb(){return globalThis.__sectionAdoptionDb}';
      if (id === '\0section-adoption:content') return 'export async function getCollection(name,filter){return globalThis.__sectionAdoptionStories.filter(filter || (()=>true))}';
      if (id === '\0section-adoption:entry') return `export * from ${JSON.stringify(path.join(root, 'src/lib/story-adopt.ts'))};\nexport * from ${JSON.stringify(path.join(root, 'src/lib/story-store.ts'))};`;
    },
  }] });
  const m = await import(pathToFileURL(bundle));
  const fixture = (id, additional) => ({ id, body: 'Synthetic adoption body.', data: { title: 'Synthetic ' + id, section: 'news', area: 'camp', author: 'Synthetic Author', date: new Date('2026-10-22T00:00:00Z'), photos: [], photoAlts: [], photoLayout: 'one', featured: false, draft: false, ...(additional === undefined ? {} : { additionalSections: additional }) } });
  globalThis.__sectionAdoptionStories = [fixture('synthetic-omitted'), fixture('synthetic-clear', []), fixture('synthetic-replace', ['kids', 'news', 'kids']), fixture('synthetic-empty')];
  for (const entry of globalThis.__sectionAdoptionStories) {
    m.upsertStory({ slug: entry.id, title: 'Old title', section: 'news', area: 'camp', additionalSections: entry.id === 'synthetic-empty' ? [] : ['youth'], author: 'Synthetic Author', date: '2026-10-22', photos: [], photoAlts: [], featured: false, draft: false, body: 'Old synthetic body.', status: 'live', source: 'git', publishedAt: 1, photoRows: [] });
  }
  let result = await m.adoptBuiltStories();
  assert.equal(result.skipped, 0); assert.equal(result.updated, 4);
  assert.deepEqual(m.getStoryBySlug('synthetic-omitted').additionalSections, ['youth']);
  console.log('PASS first adoption preserves existing extra memberships when legacy archive omits the field');
  assert.deepEqual(m.getStoryBySlug('synthetic-clear').additionalSections, []);
  console.log('PASS explicit empty archive memberships clear existing extras on adoption');
  assert.deepEqual(m.getStoryBySlug('synthetic-replace').additionalSections, ['kids']);
  console.log('PASS explicit archive memberships replace and normalize existing extras');
  assert.deepEqual(m.getStoryBySlug('synthetic-empty').additionalSections, []);
  console.log('PASS legacy omission on an empty-membership story remains empty');
  const hashes = db.prepare('SELECT slug,content_hash,rev FROM stories ORDER BY slug').all();
  globalThis.__sectionAdoptionStories[1].data.additionalSections = ['news', 'news'];
  globalThis.__sectionAdoptionStories[2].data.additionalSections = ['news', 'kids', 'kids'];
  result = await m.adoptBuiltStories();
  assert.equal(result.unchanged, 4); assert.deepEqual(db.prepare('SELECT slug,content_hash,rev FROM stories ORDER BY slug').all(), hashes);
  console.log('PASS adoption hashes represent effective inherited/canonical values and remain stable on retry');
  const previous = m.getStoryBySlug('synthetic-omitted');
  assert.equal(m.upsertStory({ ...previous, additionalSections: ['kids'] }), 'updated');
  assert.deepEqual(m.getStoryBySlug('synthetic-omitted').additionalSections, ['kids']);
  console.log('PASS explicit membership changes are not skipped by a reused content hash');
  console.log('\n6 section adoption checks passed.');
} finally { db?.close(); delete globalThis.__sectionAdoptionDb; delete globalThis.__sectionAdoptionStories; fs.rmSync(bundle, { force: true }); fs.rmSync(scratch, { recursive: true, force: true }); }
