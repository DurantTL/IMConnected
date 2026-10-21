#!/usr/bin/env node
// Real SQLite integration for modules/focal points, with only getDb redirected to a throwaway connection.
// No server, production credentials, remote requests, or source rewrites.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'rolldown';
import { deflateSync } from 'node:zlib';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';

// A tiny valid synthetic PNG: draft photos are real uploads, because a module may only show the story's own photos.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const pngChunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const syntheticPng = (shade) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 8 }, () => [shade, 90, 160]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 8 }, () => row)))), pngChunk('IEND', Buffer.alloc(0))]);
};
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
          `export * from ${JSON.stringify(path.join(root, 'src/lib/story-blocks.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/story-block-render.ts'))};`,
        ].join('\n');
      },
    }],
  });
  const m = await import(pathToFileURL(bundle));
  const now = Date.now();
  const user = Number(db.prepare("INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES ('synthetic@example.invalid','Synthetic Editor','admin','active',?,?)").run(now, now).lastInsertRowid);
  const id = m.createDraft({ source: 'editor', userId: user, fields: { title: 'Synthetic modular story', author: 'Synthetic Editor', section: 'news', area: 'conference', body: 'Original Markdown remains editable.' } });
  assert.deepEqual(m.getDraft(id).storyBlocks, []);
  const addPhoto = (draftId, alt, shade) => {
    const rel = m.writeUpload(draftId, syntheticPng(shade), 'png');
    assert.equal(m.addUploadedPhotos(draftId, m.getDraft(draftId).updatedAt, user, [{ rel, ext: 'png' }]).ok, true);
    const added = m.listPhotos(draftId).at(-1);
    db.prepare('UPDATE draft_photos SET alt = ? WHERE id = ?').run(alt, added.id);
    return m.listPhotos(draftId).at(-1);
  };
  const photo = addPhoto(id, 'Synthetic scene', 120);
  const oldVersion = m.getDraft(id).updatedAt;
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
  form.set('body', m.storyBlocksToMarkdown(blocks)); // what the editor script sends: the modules' projection
  form.set(`photo_${photo.id}_focalX`, '17'); form.set(`photo_${photo.id}_focalY`, '83');
  const parsed = m.readDraftFields(form);
  const saved = m.saveDraft(id, oldVersion, parsed.fields, parsed.photoAlts, user, parsed.layout, parsed.photoFocus);
  assert.equal(saved.ok, true);
  assert.equal(m.listPhotos(id)[0].focalX, 17);
  assert.match(m.getDraft(id).body, /Synthetic heading/);
  assert.doesNotMatch(m.getDraft(id).body, /Synthetic scene/, 'an image module adds no alt-text paragraph to the saved body');
  assert.equal(m.saveDraft(id, oldVersion, parsed.fields, parsed.photoAlts, user).reason, 'conflict');
  const legacyFields = { ...m.getDraft(id), storyBlocks: undefined };
  const legacySave = m.saveDraft(id, saved.updatedAt, legacyFields, new Map(), user);
  assert.equal(legacySave.ok, true);
  assert.equal(m.getDraft(id).storyBlocks.length, 4, 'an older save preserves modules');
  const published = await m.publishDraft(m.getDraft(id), m.listPhotos(id), legacySave.updatedAt, user);
  const story = m.getStoryBySlug(published.slug);
  assert.equal(story.photoRows[0].focalX, 17);
  assert.equal(story.photoRows[0].focalY, 83);
  assert.match(story.storyBlocks[2].url, new RegExp(`^/media/stories/${published.slug}/[0-9a-f]{64}\\.png$`), 'the module points at the story\'s own stored photo');
  assert.equal(story.storyBlocks[2].photoId, undefined, 'public modules do not contain private photo ids');
  m.recordStudioPublish([{ slug: published.slug, title: 'Synthetic Studio replacement', dek: '', section: 'news', area: 'conference', author: 'Synthetic Editor', date: m.getDraft(id).date, photoCredit: '', photoLayout: 'one', body: 'Synthetic Studio replacement text.', photos: loadedPhotos(story) }]);
  assert.deepEqual(m.getDraft(id).storyBlocks, [], 'Studio replacement clears modules on a closed linked draft');
  const sentinel = m.createDraft({ source: 'editor', userId: user });
  addPhoto(sentinel, '', 30);
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
  // M5: a Markdown edit on a modular draft (no JavaScript) is refused, never silently dropped.
  form.set('storyBlocks', JSON.stringify(blocks));
  form.set('body', `${m.storyBlocksToMarkdown(blocks)}\n\nAn edit typed into the Markdown box.`);
  assert.throws(() => m.readDraftFields(form), /Markdown box was not saved/);
  form.set('body', m.storyBlocksToMarkdown(blocks));
  assert.doesNotThrow(() => m.readDraftFields(form));

  // M3: an image module in a dashboard save names a draft photo by ID; any address is refused, on every entry path.
  for (const url of ['https://example.invalid/outside.jpg', '/media/stories/someone-else/abc.jpg', '/api/admin/photos/1']) {
    form.set('storyBlocks', JSON.stringify([{ id: 'x', type: 'image', url }]));
    form.set('body', '');
    assert.throws(() => m.readDraftFields(form), /own photos/, url);
  }
  const current = m.getDraft(id);
  const crafted = m.saveDraft(id, current.updatedAt, { ...current, storyBlocks: [{ id: 'x', type: 'image', url: '/media/stories/someone-else/abc.jpg' }] }, new Map(), user);
  assert.equal(crafted.ok, false, 'saveDraft refuses an image address even when the form reader is bypassed');
  assert.equal(crafted.code, 'block_image_url');
  const own = ['/media/stories/synthetic-own/a.jpg'];
  const base = { slug: 'synthetic-own', title: 'Own photos', section: 'news', area: 'conference', author: 'Synthetic Editor', date: '2026-01-02', photos: [], photoAlts: [], photoLayout: 'one', featured: false, draft: false, body: 'Text.', status: 'live', source: 'git', publishedAt: now, photoRows: [] };
  const withBlock = (url, image) => ({ ...base, image, imageAlt: image ? 'Lead' : undefined, storyBlocks: [{ id: 'img', type: 'image', url, alt: 'Lead' }] });
  assert.throws(() => m.writeStory(withBlock('/media/stories/synthetic-own/b.jpg', own[0]), now), /own photos/, 'the store (adoption, publish) refuses an address that is not the story\'s photo');
  assert.throws(() => m.writeStory(withBlock('/media/stories/synthetic-own/a.jpg', undefined), now), /own photos/, 'no photos, no image module');
  assert.throws(() => m.writeStory(withBlock('https://example.invalid/outside.jpg', 'https://example.invalid/outside.jpg'), now), /own photos/, 'an external address is not a valid module image even when it is the lead photo');
  assert.doesNotThrow(() => m.writeStory(withBlock(own[0], own[0]), now));
  db.prepare("UPDATE stories SET story_blocks = ?, rev = rev + 1 WHERE slug = 'synthetic-own'").run(JSON.stringify([{ id: 'img', type: 'image', url: '/media/stories/synthetic-own/zzz.jpg' }]));
  assert.equal(m.loadStory('synthetic-own').fields.storyBlocks.some((b) => b.type === 'image'), false, 'loading a story for editing drops an image module that is not one of its photos instead of adding a source');
  assert.equal(m.loadStory('synthetic-own').photos.length, 1);

  // L6: modules together cannot exceed the body limit; saving says so instead of failing at publish.
  const longBlocks = [{ id: 'a', type: 'text', text: 'x'.repeat(15_000) }, { id: 'b', type: 'text', text: 'y'.repeat(15_000) }];
  const longForm = new FormData();
  longForm.set('storyBlocks', JSON.stringify(longBlocks)); longForm.set('body', m.storyBlocksToMarkdown(longBlocks));
  assert.throws(() => m.readDraftFields(longForm), /up to 20,000 characters/);
  const tooLong = m.saveDraft(id, m.getDraft(id).updatedAt, { ...m.getDraft(id), storyBlocks: longBlocks }, new Map(), user);
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'body_long');

  // M1/L4: hostile module text is stored with "<" as &lt; and nothing is double-escaped.
  const hostile = '<script>alert(1)</script> <img src=x onerror=alert(1)>';
  const hid = m.createDraft({ source: 'editor', userId: user, fields: { title: 'Hostile modules', author: 'Synthetic Editor', section: 'news', area: 'conference', date: '2026-01-03', body: 'x' } });
  const hphoto = addPhoto(hid, hostile, 200);
  const hblocks = [
    { id: 'p', type: 'text', text: ` ${hostile} ` }, { id: 'h', type: 'heading', text: hostile, level: 3 }, { id: 'l', type: 'list', items: [hostile] },
    { id: 'q', type: 'quote', text: hostile }, { id: 'i', type: 'image', photoId: hphoto.id, alt: hostile }, { id: 'b', type: 'button', label: hostile, url: 'https://example.invalid/x' },
  ];
  const hsave = m.saveDraft(hid, m.getDraft(hid).updatedAt, { ...m.getDraft(hid), storyBlocks: hblocks }, new Map(), user);
  assert.equal(hsave.ok, true);
  const hpub = await m.publishDraft(m.getDraft(hid), m.listPhotos(hid), hsave.updatedAt, user);
  const raw = db.prepare('SELECT story_blocks, body FROM stories WHERE slug = ?').get(hpub.slug);
  assert.ok(!raw.story_blocks.includes('<'), 'stories.story_blocks holds no "<"');
  assert.ok(!raw.body.includes('<'), 'stories.body holds no "<"');
  assert.ok(!raw.body.includes('\\&lt;') && raw.body.includes('### &lt;script\\>alert(1)&lt;/script\\>'), `heading is escaped once, not twice: ${raw.body}`);
  assert.ok(!raw.body.includes('onerror=alert(1)\n\n<'), 'no raw tag');
  assert.equal(raw.body, raw.body.trim(), 'the stored body is trimmed');
  assert.ok(!JSON.stringify(m.getStoryBySlug(hpub.slug).storyBlocks).includes('<'));

  // L1: escaping must never push a field past its limit. Fields at their limit that contain "<" save, publish and render.
  const edge = async (title, blocksFor) => {
    const eid = m.createDraft({ source: 'editor', userId: user, fields: { title, author: 'Synthetic Editor', section: 'news', area: 'conference', date: '2026-01-04', body: 'x' } });
    const ephoto = addPhoto(eid, '<' + 'a'.repeat(299), 90);
    const eblocks = blocksFor(ephoto);
    const esave = m.saveDraft(eid, m.getDraft(eid).updatedAt, { ...m.getDraft(eid), storyBlocks: eblocks }, new Map(), user);
    assert.equal(esave.ok, true, `${title}: ${esave.message}`);
    const epub = await m.publishDraft(m.getDraft(eid), m.listPhotos(eid), esave.updatedAt, user);
    const estory = m.getStoryBySlug(epub.slug);
    assert.ok(!JSON.stringify(estory.storyBlocks).includes('<'));
    assert.ok((await m.renderStoryBlocksSafe(estory.storyBlocks)).length > 0, 'the stored escaped row renders without throwing');
    return estory;
  };
  const e1 = await edge('Edge fields at their limits', (p) => [
    { id: 'h', type: 'heading', level: 2, text: '<' + 'h'.repeat(299) }, { id: 'l', type: 'list', items: ['<' + 'i'.repeat(1999)] },
    { id: 'i', type: 'image', photoId: p.id, alt: '<' + 'a'.repeat(299) }, { id: 'b', type: 'button', label: '<' + 'b'.repeat(119), url: 'https://example.invalid/x' },
  ]);
  assert.equal(e1.storyBlocks[0].text.length, 300 + 3, 'heading stored escaped (300 typed characters)');
  await edge('Edge long paragraph', () => [{ id: 'p', type: 'text', text: 'p'.repeat(19_990) + '<<<<<' + 'q'.repeat(5) }]);

  // L2: loading a live story into the editor shows what was typed ("<"), and writing escapes it again.
  const loadedEdge = m.loadStory(e1.slug);
  assert.equal(loadedEdge.fields.storyBlocks[0].text, '<' + 'h'.repeat(299));
  assert.equal(loadedEdge.fields.storyBlocks[1].items[0], '<' + 'i'.repeat(1999));
  assert.equal(loadedEdge.fields.storyBlocks[3].label, '<' + 'b'.repeat(119));

  console.log('PASS modules: migration, persistence, legacy save, conflict, publishing, focus, live edit remapping, photo deletion');
} finally {
  db?.close();
  delete globalThis.__storyBuilderTestDb;
  fs.rmSync(bundle, { force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
}
