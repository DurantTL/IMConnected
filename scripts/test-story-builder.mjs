#!/usr/bin/env node
// Real SQLite integration for modules/focal points, with only getDb redirected to a throwaway connection.
// No server, production credentials, remote requests, or source rewrites.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'rolldown';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';

const loadedPhotos = (story) => [story.image, ...story.photos].filter(Boolean).map((url) => ({ url, alt: '', caption: '' }));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-story-builder-'));
const bundle = path.join(root, 'node_modules', `.story-builder-test-${process.pid}.mjs`);
process.env.DATA_DIR = scratch;
let db;
try {
  db = openDatabase(scratch);
  runMigrations(db, readMigrationsFromDir(path.join(root, 'src/lib/db/migrations')));
  globalThis.__storyBuilderTestDb = db;
  await build({
    input: 'story-builder-test:entry',
    output: { file: bundle, format: 'esm' },
    platform: 'node',
    external: [/^node:/, '@astrojs/markdown-satteri'],
    plugins: [{
      name: 'isolated-story-builder-db',
      resolveId(source) {
        if (source === 'story-builder-test:entry' || source === 'story-builder-test:db') return `\0${source}`;
        if (/^(?:\.\.\/|\.\/)*(?:lib\/)?db$/.test(source)) return '\0story-builder-test:db';
      },
      load(id) {
        if (id === '\0story-builder-test:db') return 'export function getDb(){return globalThis.__storyBuilderTestDb}';
        if (id === '\0story-builder-test:entry') return [
          `export * from ${JSON.stringify(path.join(root, 'src/lib/drafts.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/draft-form.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/story-publish.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/story-store.ts'))};`,
        ].join('\n');
      },
    }],
  });
  const m = await import(pathToFileURL(bundle));
  const now = Date.now();
  const user = Number(db.prepare("INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES ('synthetic@example.invalid','Synthetic Editor','admin','active',?,?)").run(now, now).lastInsertRowid);
  const id = m.createDraft({ source: 'editor', userId: user, fields: { title: 'Synthetic modular story', author: 'Synthetic Editor', section: 'news', area: 'conference', body: 'Original Markdown remains editable.' } });
  assert.deepEqual(m.getDraft(id).storyBlocks, []);
  const oldVersion = m.getDraft(id).updatedAt;
  m.replacePhotos(id, [{ url: 'https://example.invalid/photo.jpg', alt: 'Synthetic scene', caption: '' }]);
  const photo = m.listPhotos(id)[0];
  assert.equal(photo.focalX, 50);
  const blocks = [
    { id: 'heading-1', type: 'heading', text: 'Synthetic heading', level: 2 },
    { id: 'text-1', type: 'text', text: 'A synthetic paragraph with meaningful searchable story text.' },
    { id: 'image-1', type: 'image', photoId: photo.id, alt: 'Synthetic scene' },
    { id: 'action-1', type: 'button', label: 'Read details', url: 'https://example.invalid/details' },
  ];
  const form = new FormData();
  for (const [key, value] of Object.entries(m.getDraft(id))) if (typeof value === 'string') form.set(key, value);
  form.set('storyBlocks', JSON.stringify(blocks));
  form.set(`photo_${photo.id}_focalX`, '17'); form.set(`photo_${photo.id}_focalY`, '83');
  const parsed = m.readDraftFields(form);
  const saved = m.saveDraft(id, oldVersion, parsed.fields, parsed.photoAlts, user, parsed.layout, parsed.photoFocus);
  assert.equal(saved.ok, true);
  assert.equal(m.listPhotos(id)[0].focalX, 17);
  assert.match(m.getDraft(id).body, /Synthetic heading/);
  assert.equal(m.saveDraft(id, oldVersion, parsed.fields, parsed.photoAlts, user).reason, 'conflict');
  const legacyFields = { ...m.getDraft(id), storyBlocks: undefined };
  const legacySave = m.saveDraft(id, saved.updatedAt, legacyFields, new Map(), user);
  assert.equal(legacySave.ok, true);
  assert.equal(m.getDraft(id).storyBlocks.length, 4, 'an older save preserves modules');
  const published = await m.publishDraft(m.getDraft(id), m.listPhotos(id), legacySave.updatedAt, user);
  const story = m.getStoryBySlug(published.slug);
  assert.equal(story.photoRows[0].focalX, 17);
  assert.equal(story.photoRows[0].focalY, 83);
  assert.equal(story.storyBlocks[2].url, 'https://example.invalid/photo.jpg');
  assert.equal(story.storyBlocks[2].photoId, undefined, 'public modules do not contain private photo ids');
  m.recordStudioPublish([{ slug: published.slug, title: 'Synthetic Studio replacement', dek: '', section: 'news', area: 'conference', author: 'Synthetic Editor', date: m.getDraft(id).date, photoCredit: '', photoLayout: 'one', body: 'Synthetic Studio replacement text.', photos: loadedPhotos(story) }]);
  assert.deepEqual(m.getDraft(id).storyBlocks, [], 'Studio replacement clears modules on a closed linked draft');
  const sentinel = m.createDraft({ source: 'editor', userId: user });
  m.replacePhotos(sentinel, [{ url: 'https://example.invalid/sentinel.jpg', alt: '', caption: '' }]);
  const loaded = m.loadStory(published.slug);
  m.reloadDraftFromStory(id, user, loaded.fields, loaded.photos);
  const reopened = m.getDraft(id), reopenedPhoto = m.listPhotos(id)[0];
  assert.notEqual(reopenedPhoto.id, photo.id);
  assert.equal(reopened.storyBlocks[2].photoId, reopenedPhoto.id, 'editing live content remaps image references');
  assert.equal(reopenedPhoto.focalY, 83);
  const removed = m.changePhoto(id, reopened.updatedAt, user, 'delete', reopenedPhoto.id);
  assert.equal(removed.ok, true);
  assert.equal(m.getDraft(id).storyBlocks.some((b) => b.type === 'image'), false);
  form.set(`photo_${photo.id}_focalX`, '101');
  assert.throws(() => m.readDraftFields(form), /between 0 and 100/);
  form.set(`photo_${photo.id}_focalX`, '17');
  form.set('storyBlocks', JSON.stringify([{ id: 'bad', type: 'button', url: 'javascript:alert(1)' }]));
  assert.throws(() => m.readDraftFields(form), /Button links/);
  console.log('PASS modules: migration, persistence, legacy save, conflict, publishing, focus, live edit remapping, photo deletion');
} finally {
  db?.close();
  delete globalThis.__storyBuilderTestDb;
  fs.rmSync(bundle, { force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
}
