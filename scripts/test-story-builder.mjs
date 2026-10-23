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
    external: [/^node:/, '@astrojs/markdown-satteri', 'satteri'],
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
          `export * from ${JSON.stringify(path.join(root, 'src/lib/draft-revisions.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/revision-media.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/editor-layouts.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/agent.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/announcement.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/announcement-render.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/draft-form.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/story-publish.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/publish.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/story-store.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/story-blocks.ts'))};`,
          `export * from ${JSON.stringify(path.join(root, 'src/lib/story-block-render.ts'))};`,
          `export { renderInlinePhoto } from ${JSON.stringify(path.join(root, 'src/lib/story-media-render.ts'))};`,
          `export { restrictPreviewImages } from ${JSON.stringify(path.join(root, 'src/lib/markdown.ts'))};`,
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
  assert.equal(photo.zoom, 1, 'old and newly uploaded photos default to 100%');
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
  form.set(`photo_${photo.id}_zoom`, '1.8');
  const parsed = m.readDraftFields(form);
  const saved = m.saveDraft(id, oldVersion, parsed.fields, parsed.photoAlts, user, parsed.layout, parsed.photoFocus);
  assert.equal(saved.ok, true);
  assert.equal(m.listPhotos(id)[0].focalX, 17);
  assert.equal(m.listPhotos(id)[0].zoom, 1.8);
  assert.match(m.getDraft(id).body, /Synthetic heading/);
  assert.doesNotMatch(m.getDraft(id).body, /Synthetic scene/, 'an image module adds no alt-text paragraph to the saved body');
  assert.equal(m.saveDraft(id, oldVersion, parsed.fields, parsed.photoAlts, user).reason, 'conflict');
  const legacyFields = { ...m.getDraft(id), storyBlocks: undefined };
  const legacySave = m.saveDraft(id, saved.updatedAt, legacyFields, new Map(), user);
  assert.equal(legacySave.ok, true);
  assert.equal(m.getDraft(id).storyBlocks.length, 4, 'an older save preserves modules');
  assert.equal(m.listPhotos(id)[0].zoom, 1.8, 'older clients omitting crop fields preserve saved zoom');
  const partialForm = new FormData(); partialForm.set(`photo_${photo.id}_focalX`, '17');
  assert.deepEqual(m.readDraftFields(partialForm).photoFocus.get(photo.id), { focalX: 17 }, 'partial legacy crop forms do not reset other crop values');
  for (const value of ['', 'NaN', 'Infinity', '.99', '3.01', '2;display:none']) {
    partialForm.set(`photo_${photo.id}_zoom`, value);
    assert.throws(() => m.readDraftFields(partialForm), /zoom/i);
  }
  assert.throws(() => db.prepare('UPDATE draft_photos SET zoom = 4 WHERE id = ?').run(photo.id), /CHECK constraint/);
  const published = await m.publishDraft(m.getDraft(id), m.listPhotos(id), legacySave.updatedAt, user);
  const story = m.getStoryBySlug(published.slug);
  assert.equal(story.photoRows[0].focalX, 17);
  assert.equal(story.photoRows[0].focalY, 83);
  assert.equal(story.photoRows[0].zoom, 1.8);
  assert.equal(story.storyBlocks[2].zoom, 1.8);
  assert.match(story.storyBlocks[2].url, new RegExp(`^/media/stories/${published.slug}/[0-9a-f]{64}\\.png$`), 'the module points at the story\'s own stored photo');
  assert.equal(story.storyBlocks[2].photoId, undefined, 'public modules do not contain private photo ids');
  m.recordStudioPublish([{ slug: published.slug, title: 'Synthetic Studio replacement', dek: '', section: 'news', area: 'conference', author: 'Synthetic Editor', date: m.getDraft(id).date, photoCredit: '', photoLayout: 'one', body: 'Synthetic Studio replacement text.', photos: loadedPhotos(story) }]);
  assert.deepEqual(m.getDraft(id).storyBlocks, [], 'Studio replacement clears modules on a closed linked draft');
  const sentinel = m.createDraft({ source: 'editor', userId: user });
  addPhoto(sentinel, '', 30);
  const loaded = m.loadStory(published.slug);
  assert.equal(loaded.photos[0].zoom, 1.8, 'loading a live story keeps the saved zoom');
  m.reloadDraftFromStory(id, user, loaded.fields, loaded.photos);
  const reopened = m.getDraft(id), reopenedPhoto = m.listPhotos(id)[0];
  assert.notEqual(reopenedPhoto.id, photo.id);
  assert.equal(reopened.storyBlocks[2].photoId, reopenedPhoto.id, 'editing live content remaps image references');
  assert.equal(reopenedPhoto.focalY, 83);
  assert.equal(reopenedPhoto.zoom, 1.8, 'reopening a story keeps the crop while remapping photo IDs');
  assert.equal(reopened.storyBlocks[2].zoom, undefined, 'editable modules use the authoritative photo crop');
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

  // Studio crop compatibility: real prepared requests and publish transactions.
  // Visual galleries keep ordered references through duplicate-byte publish/reopen and photo removal.
  const gid = m.createDraft({ source: 'editor', userId: user, fields: { title: 'Synthetic visual gallery', author: 'Synthetic Editor', section: 'news', area: 'conference', body: 'Synthetic gallery text.' } });
  const gp1 = addPhoto(gid, 'First slot', 90), gp2 = addPhoto(gid, 'Second slot', 90);
  const gblocks = [{ id: 'gtext', type: 'text', text: 'Synthetic gallery text.' }, { id: 'gallery', type: 'gallery', columns: 3, photos: [{ photoId: gp2.id, alt: 'Second <slot>' }, { photoId: gp1.id }] }];
  const gs = m.saveDraft(gid, m.getDraft(gid).updatedAt, { ...m.getDraft(gid), storyBlocks: gblocks }, new Map([[gp1.id, 'Corrected description']]), user, null, new Map([[gp2.id, { zoom: 2.5, focalX: 0 }]]));
  assert.equal(gs.ok, true);
  assert.equal(m.saveDraft(gid, gs.updatedAt, { ...m.getDraft(gid), storyBlocks: [{ ...gblocks[1], photos: [{ photoId: photo.id }] }] }, new Map(), user).ok, false, 'gallery cannot claim another draft photo');
  const gpub = await m.publishDraft(m.getDraft(gid), m.listPhotos(gid), gs.updatedAt, user);
  const gst = m.getStoryBySlug(gpub.slug), grefs = gst.storyBlocks[1].photos;
  assert.deepEqual(grefs.map((p) => p.photoIndex), [1, 0]); assert.deepEqual(grefs.map((p) => p.zoom), [2.5, 1]);
  assert.equal(grefs[0].url, grefs[1].url, 'fixture intentionally has identical bytes');
  assert.equal(grefs[1].alt, 'Corrected description', 'gallery without an override follows the photo description at publish'); assert.equal(grefs[0].alt, 'Second &lt;slot>'); assert.ok(grefs.every((p) => !p.photoId));
  const gl = m.loadStory(gpub.slug); m.reloadDraftFromStory(gid, user, gl.fields, gl.photos);
  const gr = m.listPhotos(gid), gd = m.getDraft(gid);
  assert.deepEqual(gd.storyBlocks[1].photos.map((p) => p.photoId), [gr[1].id, gr[0].id], 'same-URL gallery positions remap to the correct distinct draft IDs');
  assert.equal(m.changePhoto(gid, gd.updatedAt, user, 'delete', gr[1].id).ok, true);
  assert.deepEqual(m.getDraft(gid).storyBlocks[1].photos.map((p) => p.photoId), [gr[0].id], 'deleting one photo preserves other gallery references and text');
  await assert.rejects(() => m.publishDraft(m.getDraft(gid), m.listPhotos(gid), m.getDraft(gid).updatedAt, user), (e) => e.code === 'blocks_bad');
  const sid = m.createDraft({ source: 'editor', userId: user, fields: { title: 'Synthetic section story', author: 'Synthetic Editor', section: 'news', area: 'conference', body: 'Synthetic grouped text.' } });
  const sp = addPhoto(sid, 'Column image', 101);
  const sblocks = [{ id: 'section', type: 'section', content: [[{ id: 'c1', type: 'text', text: 'First <column> **story**.', align: 'right', spacing: 'relaxed' }, { id: 'ci', type: 'image', photoId: sp.id }], [{ id: 'c2', type: 'text', text: 'Second column story.' }, { id: 'cb', type: 'button', label: 'Read details', url: 'https://example.invalid/columns' }]] }];
  const ss = m.saveDraft(sid, m.getDraft(sid).updatedAt, { ...m.getDraft(sid), storyBlocks: sblocks }, new Map(), user); assert.equal(ss.ok, true);
  const forgedSections = [{ id: 'section', type: 'section', content: [[{ id: 'foreign', type: 'image', photoId: reopenedPhoto.id }]] }];
  assert.equal(m.saveDraft(sid, ss.updatedAt, { ...m.getDraft(sid), storyBlocks: forgedSections }, new Map(), user).ok, false, 'nested image IDs must belong to this draft');
  const spp = await m.publishDraft(m.getDraft(sid), m.listPhotos(sid), ss.updatedAt, user), sst = m.getStoryBySlug(spp.slug);
  assert.equal(sst.storyBlocks[0].content[0][0].align, 'right'); assert.equal(sst.storyBlocks[0].content[0][0].spacing, 'relaxed'); assert.equal(sst.storyBlocks[0].content[0][1].photoIndex, 0); assert.equal(sst.storyBlocks[0].content[0][1].photoId, undefined); assert.match(sst.storyBlocks[0].content[0][0].text, /&lt;column>/);
  const sl = m.loadStory(spp.slug); m.reloadDraftFromStory(sid, user, sl.fields, sl.photos);
  assert.equal(m.getDraft(sid).storyBlocks[0].content[0][0].align, 'right');
  assert.equal(m.getDraft(sid).storyBlocks[0].content[0][1].photoId, m.listPhotos(sid)[0].id);
  assert.equal(m.changePhoto(sid, m.getDraft(sid).updatedAt, user, 'delete', m.listPhotos(sid)[0].id).ok, true);
  assert.equal(m.storyBlockPhotos(m.getDraft(sid).storyBlocks).length, 0); assert.equal(m.getDraft(sid).storyBlocks[0].content[1][0].text, 'Second column story.');
  const named = m.saveEditorLayout(user, 'Synthetic <layout>', sblocks);
  const structures = m.listEditorLayouts(user), structure = structures.find((l) => l.id === named);
  assert.equal(structure.name, 'Synthetic <layout>'); assert.equal(structure.blocks[0].content[0][0].align, 'right');
  const storedStructure = JSON.stringify(structure.blocks); for (const forbidden of ['First', 'https:', 'photoId', 'photoIndex', 'focalX', 'Column image']) assert.ok(!storedStructure.includes(forbidden), 'saved layout excludes ' + forbidden);
  const otherUser = Number(db.prepare("INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES('other-layout@example.invalid','Other Synthetic Editor','editor','active',?,?)").run(now, now).lastInsertRowid);
  assert.deepEqual(m.listEditorLayouts(otherUser), []); assert.equal(m.deleteEditorLayout(otherUser, named), false); assert.equal(m.listEditorLayouts(user).length, 1);
  for (let i = 1; i < 50; i++) m.saveEditorLayout(user, 'Synthetic ' + i, [{ id: 'blank', type: 'text', text: 'Private story text' }]);
  assert.throws(() => m.saveEditorLayout(user, 'Excess', sblocks), /up to 50/); assert.equal(m.deleteEditorLayout(user, named), true); assert.equal(m.listEditorLayouts(user).length, 49);
  // Typed agent announcements preserve omission/clearing and remain subject to human review.
  const agentBase = { title: 'Synthetic event flyer', body: 'Accessible synthetic event summary.', author: 'Synthetic Editor', section: 'news', area: 'conference', sourceUrl: 'https://example.invalid/source/bulletin', photos: [{ data: `data:image/png;base64,${syntheticPng(33).toString('base64')}`, alt: 'Synthetic event flyer' }] };
  const bulletin = { kind: 'event', eventDate: '2026-12-01', location: 'Synthetic Hall <north>', links: [{ label: 'Register <here>', url: 'https://example.invalid/register' }], videoUrl: 'https://youtu.be/abcdefghijk' };
  const ainput = m.parseAgentStory({ ...agentBase, announcement: bulletin });
  const acreated = m.upsertAgentDraft(ainput), aid = acreated.id;
  assert.equal(m.getDraft(aid).status, 'new'); assert.equal(m.getDraft(aid).source, 'agent'); assert.equal(m.getDraft(aid).announcement.videoUrl, 'https://www.youtube.com/watch?v=abcdefghijk');
  const without = m.parseAgentStory({ ...agentBase, photos: undefined });
  assert.equal(m.upsertAgentDraft(without).ok, true); assert.equal(m.getDraft(aid).announcement.kind, 'event');
  assert.equal(m.upsertAgentDraft({ ...without, announcement: null }).ok, true); assert.equal(m.getDraft(aid).announcement, null);
  m.upsertAgentDraft({ ...without, announcementPatch: ainput.announcementPatch });
  for (const bad of [{ kind: 'other' }, { kind: 'event', eventDate: '2026-02-30' }, { kind: 'event', links: [{ label: 'Bad', url: 'javascript:alert(1)' }] }, { kind: 'announcement', videoUrl: 'https://youtube.com.evil.invalid/embed/abcdefghijk' }, { kind: 'event', links: Array.from({ length: 4 }, () => ({ label: 'Link', url: 'https://example.invalid/' })) }]) assert.throws(() => m.parseAgentStory({ ...agentBase, announcement: bad }), (e) => e.code === 'bad_announcement');
  const ap = m.listPhotos(aid)[0];
  const ablocks = [{ id: 'summary', type: 'text', text: agentBase.body }, { id: 'flyer', type: 'flyer', photoId: ap.id }, { id: 'video', type: 'video', label: 'Synthetic video <title>', url: 'https://vimeo.com/12345678' }, { id: 'link', type: 'button', label: 'Register', url: 'https://example.invalid/register' }];
  const asaved = m.saveDraft(aid, m.getDraft(aid).updatedAt, { ...m.getDraft(aid), storyBlocks: ablocks, announcement: undefined }, new Map(), user, null, new Map([[ap.id, { zoom: 3, focalX: 0 }]]));
  assert.equal(asaved.ok, true); assert.equal(m.getDraft(aid).announcement.kind, 'event', 'older editor forms preserve metadata');
  assert.equal(m.upsertAgentDraft(without).ok, false, 'agent cannot change a reviewed event');
  const apub = await m.publishDraft(m.getDraft(aid), m.listPhotos(aid), asaved.updatedAt, user);
  const ast = m.getStoryBySlug(apub.slug);
  assert.equal(ast.announcement.kind, 'event');
  const ahtml = await m.renderStoryBlocksSafe(ast.storyBlocks);
  assert.match(ahtml, /story-flyer/); assert.doesNotMatch(ahtml.slice(ahtml.indexOf('story-flyer'), ahtml.indexOf('story-module-video')), /aspect-ratio:16|scale:3/); assert.match(ahtml, /data-video-embed="https:\/\/player.vimeo.com\/video\/12345678"/); assert.doesNotMatch(ahtml, /<iframe|<title>/);
  const aprivate = await m.renderStoryBlocksSafe(ast.storyBlocks, { preview: true }); assert.doesNotMatch(aprivate, /data-load-video|<iframe/);
  const details = await m.renderAnnouncementDetails(ast.announcement);
  assert.match(details, /Synthetic Hall &lt;north&gt;/); assert.match(details, /Register &lt;here&gt;/); assert.doesNotMatch(details, /<north>/);
  const al = m.loadStory(apub.slug); m.reloadDraftFromStory(aid, user, al.fields, al.photos); assert.equal(m.getDraft(aid).announcement.kind, 'event'); assert.equal(m.getDraft(aid).storyBlocks[1].photoId, m.listPhotos(aid)[0].id);
  const aold = m.getDraft(aid); assert.equal(m.saveDraft(aid, aold.updatedAt - 1, { ...aold, announcement: null }, new Map(), user).reason, 'conflict'); assert.equal(m.getDraft(aid).announcement.kind, 'event', 'stale save does not clear event metadata');
  // Old Studio payloads retain live metadata and carry it to closed history; open editor work is preserved.
  const astro = m.prepareStudioPublish({ newsletter: { name: 'Synthetic bulletin review', issueDate: ast.date }, stories: [{ title: ast.title, section: 'news', area: 'conference', author: ast.author, date: ast.date, body: agentBase.body, photos: [{ url: agentBase.photos[0].data, alt: 'Synthetic event flyer', caption: '' }], }] });
  assert.equal(astro.stories[0].slug, apub.slug);
  await m.publishStudioStories(astro.stories); assert.equal(m.getStoryBySlug(apub.slug).announcement.kind, 'event'); assert.equal(m.getDraft(aid).announcement.kind, 'event');
  const pngData = (shade) => `data:image/png;base64,${syntheticPng(shade).toString('base64')}`;
  const studioRequest = (photos, title = 'Synthetic Studio crops') => ({ newsletter: { name: 'Synthetic review', issueDate: '2026-01-08' }, stories: [{ ref: 'studio-crop', title, author: 'Synthetic Editor', section: 'news', area: 'conference', body: 'Synthetic Studio crop compatibility story.', photoLayout: 'mosaic', photos }] });
  const sendStudio = (request) => m.publishStudioStories(m.prepareStudioPublish(request).stories);
  const a = { url: pngData(45), alt: 'Synthetic A', caption: '', focalX: 0, focalY: 100, zoom: 3 };
  const b = { url: pngData(65), alt: 'Synthetic B', caption: '', focalX: 17, focalY: 83, zoom: 1.8 };
  const first = await sendStudio(studioRequest([a, b]));
  const studioSlug = first.stories[0].slug;
  const crops = () => m.getStoryBySlug(studioSlug).photoRows.map(({ focalX, focalY, zoom }) => ({ focalX, focalY, zoom }));
  assert.deepEqual(crops(), [{ focalX: 0, focalY: 100, zoom: 3 }, { focalX: 17, focalY: 83, zoom: 1.8 }]);
  assert.deepEqual(m.listPhotos(first.ids[0]).map(({ focalX, focalY, zoom }) => ({ focalX, focalY, zoom })), crops(), 'closed Studio draft and live story use the same effective crop');
  for (const key of ['focalX', 'focalY', 'zoom']) for (const value of [null, '2', {}, NaN, Infinity, key === 'zoom' ? .99 : -1, key === 'zoom' ? 3.01 : 101]) {
    assert.throws(() => m.prepareStudioPublish(studioRequest([{ ...a, [key]: value }])), (error) => error instanceof m.PublishError && error.ref === 'studio-crop' && error.message.includes(key));
  }
  const oldA = { url: a.url, alt: a.alt, caption: '' }, oldB = { url: b.url, alt: b.alt, caption: '' };
  await sendStudio(studioRequest([oldB, oldA]));
  assert.deepEqual(crops(), [{ focalX: 17, focalY: 83, zoom: 1.8 }, { focalX: 0, focalY: 100, zoom: 3 }], 'same-byte photos keep their crop after an old-client reorder');
  await sendStudio(studioRequest([{ ...oldB, focalX: 50 }, { url: pngData(85), alt: 'Replacement' }]));
  assert.deepEqual(crops(), [{ focalX: 50, focalY: 83, zoom: 1.8 }, { focalX: 50, focalY: 50, zoom: 1 }], 'partial omissions preserve other fields and replacement identities use defaults');
  const pending = sendStudio(studioRequest([oldB]));
  db.prepare('UPDATE story_photos SET focal_x=23, zoom=2.2 WHERE story_id=? AND position=0').run(m.getStoryBySlug(studioSlug).id);
  await pending;
  assert.deepEqual(crops(), [{ focalX: 23, focalY: 83, zoom: 2.2 }], 'omitted crop inherits a concurrent edit committed during asynchronous photo preparation');
  await sendStudio(studioRequest([{ ...oldB, focalX: 50, focalY: 50, zoom: 1 }]));
  assert.deepEqual(crops(), [{ focalX: 50, focalY: 50, zoom: 1 }], 'explicit defaults reset the crop');
  await sendStudio(studioRequest([{ ...a, zoom: 1.4 }, { ...a, zoom: 2.4 }]));
  await sendStudio(studioRequest([oldA, oldA]));
  assert.deepEqual(crops().map((crop) => crop.zoom), [1.4, 2.4], 'duplicate identities prefer their previous positions');
  const live = m.loadStory(studioSlug);
  m.reloadDraftFromStory(first.ids[0], user, live.fields, live.photos);
  const openPhotos = m.listPhotos(first.ids[0]);
  await sendStudio(studioRequest([{ ...a, zoom: 2.8 }]));
  assert.deepEqual(m.listPhotos(first.ids[0]), openPhotos, 'Studio preserves an editor\'s open draft photos');
  const beforeRollback = crops();
  db.exec("CREATE TRIGGER synthetic_crop_rollback BEFORE INSERT ON stories WHEN NEW.title = 'Synthetic rollback blocker' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  const multi = studioRequest([{ ...a, zoom: 1.1 }]);
  multi.stories.push({ ...multi.stories[0], ref: 'rollback', title: 'Synthetic rollback blocker' });
  await assert.rejects(sendStudio(multi), /synthetic failure/);
  assert.deepEqual(crops(), beforeRollback, 'a failed multi-story publish rolls back crop updates');
  db.exec('DROP TRIGGER synthetic_crop_rollback');
  const remote = await sendStudio(studioRequest([{ url: 'https://EXAMPLE.invalid:443/synthetic.png', focalX: 12, focalY: 34, zoom: 1.9 }], 'Synthetic remote crop'));
  await sendStudio(studioRequest([{ url: 'https://example.invalid/synthetic.png' }], 'Synthetic remote crop'));
  assert.equal(m.getStoryBySlug(remote.stories[0].slug).photoRows[0].zoom, 1.9, 'normalized remote URLs inherit crop without fetching remote bytes');

  // Persisted revisions are editorial-only, bounded, atomic and never publish or bind reused photo IDs.
  const rid = m.createDraft({ source: 'editor', userId: user, fields: { title: 'Revision baseline', author: 'Synthetic Editor', section: 'news', area: 'conference', body: 'Synthetic revision body.' }, submitter: { name: 'Private submitter sentinel', email: 'private-sentinel@example.invalid', phone: '555-0100' }, sourceUrl: 'https://example.invalid/private-source', agentNote: 'Private agent note sentinel' });
  const rsave = (patch = {}) => m.saveDraft(rid, m.getDraft(rid).updatedAt, { ...m.getDraft(rid), ...patch }, new Map(), user);
  assert.equal(rsave().ok, true); assert.equal(m.listDraftRevisions(rid).length, 0, 'unchanged save has no revision');
  for (let i = 0; i < 25; i++) assert.equal(rsave({ title: 'Revision title ' + i }).ok, true);
  assert.equal(m.listDraftRevisions(rid).length, 20);
  const privatePayload = db.prepare('SELECT payload FROM draft_revisions WHERE draft_id=?').all(rid).map((r) => r.payload).join('');
  for (const secret of ['Private submitter sentinel', 'private-sentinel@example.invalid', '555-0100', 'private-source', 'Private agent note sentinel', 'submitterEmail', 'agentNote', 'sourceUrl']) assert.ok(!privatePayload.includes(secret), 'revision excludes ' + secret);
  const targetRevision = m.listDraftRevisions(rid)[0].id, beforeRestore = m.getDraft(rid), storiesBeforeRestore = db.prepare('SELECT COUNT(*) n FROM stories').get().n;
  assert.equal(m.restoreDraftRevision(rid, beforeRestore.updatedAt - 1, targetRevision, user).reason, 'conflict');
  assert.equal(m.restoreDraftRevision(rid, beforeRestore.updatedAt, m.listDraftRevisions(id)[0].id, user).code, 'revision_gone', 'cross-draft revision cannot be restored');
  const restored = m.restoreDraftRevision(rid, beforeRestore.updatedAt, targetRevision, user); assert.equal(restored.ok, true); assert.equal(m.getDraft(rid).title, 'Revision title 23');
  assert.equal(m.listDraftRevisions(rid).length, 20); assert.equal(db.prepare('SELECT COUNT(*) n FROM stories').get().n, storiesBeforeRestore, 'restore never publishes');
  assert.equal(m.readDraftRevision(rid, m.listDraftRevisions(rid)[0].id).fields.title, 'Revision title 24', 'restoring records the current state as a new revision');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='draft.revision_restore' AND target=?").get(`draft:${rid}`));
  db.prepare("UPDATE drafts SET status='published' WHERE id=?").run(rid); assert.equal(m.restoreDraftRevision(rid, m.getDraft(rid).updatedAt, targetRevision, user).reason, 'locked'); db.prepare("UPDATE drafts SET status='in_review' WHERE id=?").run(rid);
  const rollbackRevisionBefore = m.getDraft(rid), revisionIdsBefore = m.listDraftRevisions(rid).map((r) => r.id);
  db.exec(`CREATE TRIGGER synthetic_revision_failure BEFORE INSERT ON draft_revisions WHEN NEW.draft_id=${rid} BEGIN SELECT RAISE(ABORT,'synthetic revision failure'); END`);
  assert.throws(() => rsave({ title: 'Must rollback' }), /synthetic revision failure/); assert.equal(m.getDraft(rid).title, rollbackRevisionBefore.title); assert.equal(m.getDraft(rid).updatedAt, rollbackRevisionBefore.updatedAt); assert.deepEqual(m.listDraftRevisions(rid).map((r) => r.id), revisionIdsBefore);
  const failedUpload = m.writeUpload(rid, syntheticPng(31), 'png'); assert.throws(() => m.addUploadedPhotos(rid, m.getDraft(rid).updatedAt, user, [{ rel: failedUpload, ext: 'png' }]), /synthetic revision failure/); assert.ok(!fs.existsSync(path.join(scratch, 'uploads', failedUpload)), 'history failure cleans newly written uploads');
  db.exec('DROP TRIGGER synthetic_revision_failure');
  db.exec("CREATE TRIGGER synthetic_revision_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='draft.revision_restore' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.throws(() => m.restoreDraftRevision(rid, m.getDraft(rid).updatedAt, targetRevision, user), /synthetic audit failure/); assert.equal(m.getDraft(rid).updatedAt, rollbackRevisionBefore.updatedAt); assert.deepEqual(m.listDraftRevisions(rid).map((r) => r.id), revisionIdsBefore); db.exec('DROP TRIGGER synthetic_revision_audit_failure');
  const mediaDraft = m.createDraft({ source: 'editor', userId: user, fields: { title: 'Revision media example', author: 'Synthetic Editor', section: 'news', area: 'conference', body: 'Synthetic media revision body.' } });
  const priorPhoto = addPhoto(mediaDraft, 'Old description', 77);
  const mediaBlocks = [{ id: 'revision-text', type: 'text', text: 'Synthetic media revision body.' }, { id: 'revision-image', type: 'image', photoId: priorPhoto.id }];
  assert.equal(m.saveDraft(mediaDraft, m.getDraft(mediaDraft).updatedAt, { ...m.getDraft(mediaDraft), storyBlocks: mediaBlocks }, new Map(), user, null, new Map([[priorPhoto.id, { zoom: 3, focalX: 0 }]])).ok, true);
  const priorKey = db.prepare('SELECT media_key FROM draft_photos WHERE id=?').get(priorPhoto.id).media_key;
  assert.equal(m.changePhoto(mediaDraft, m.getDraft(mediaDraft).updatedAt, user, 'delete', priorPhoto.id).ok, true); const mediaRevision = m.listDraftRevisions(mediaDraft)[0].id;
  const replacement = addPhoto(mediaDraft, 'Replacement description', 88), replacementKey = db.prepare('SELECT media_key FROM draft_photos WHERE id=?').get(replacement.id).media_key;
  assert.equal(replacement.id, priorPhoto.id, 'fixture exercises SQLite integer ID reuse'); assert.notEqual(replacementKey, priorKey);
  const restoredMedia = m.restoreDraftRevision(mediaDraft, m.getDraft(mediaDraft).updatedAt, mediaRevision, user); assert.equal(restoredMedia.ok, true); assert.equal(restoredMedia.warnings.length, 1);
  assert.equal(m.storyBlockPhotos(m.getDraft(mediaDraft).storyBlocks).length, 0, 'old image reference cannot bind a replacement with the same integer ID'); assert.equal(m.listPhotos(mediaDraft)[0].zoom, 1); assert.equal(m.listPhotos(mediaDraft)[0].alt, 'Replacement description'); assert.ok(!fs.existsSync(path.join(scratch, 'uploads', priorPhoto.path))); assert.ok(fs.existsSync(path.join(scratch, 'uploads', replacement.path)));
  const beforeNoopHistory = m.listDraftRevisions(mediaDraft).length; assert.equal(m.changePhoto(mediaDraft, m.getDraft(mediaDraft).updatedAt, user, 'lead', replacement.id).ok, true); assert.equal(m.listDraftRevisions(mediaDraft).length, beforeNoopHistory, 'boundary photo no-op does not churn history');
  const markerSource = 'Before.\n{{photo 1}}\n{{photo 2}}\n{{gallery 1-2 columns=2}}\n\n`{{photo 1}}`\n\n```text\n{{photo 1}}\n```\n\n[{{photo 1}}](https://example.invalid/)\n\n\\{{photo 1}}';
  const remappedMarkers = m.restoreMediaMarkers(markerSource, ['gone', 'kept'], ['kept', 'replacement']);
  assert.ok(remappedMarkers.missing); assert.match(remappedMarkers.body, /^\{\{photo missing\}\}$/m); assert.match(remappedMarkers.body, /^\{\{gallery missing\}\}$/m); assert.match(remappedMarkers.body, /`\{\{photo 1\}\}`/); assert.match(remappedMarkers.body, /```text\n\{\{photo 1\}\}\n```/); assert.ok(remappedMarkers.body.endsWith('\\{{photo 1}}'));
  assert.equal(m.restoreMediaMarkers('{{photo 3}}', ['gone'], ['a', 'b', 'new']).body, '{{photo missing}}', 'old invalid index cannot acquire a replacement photo');
  // Fit whole photo (issue #82): editor form -> draft -> publish -> reopen -> republish, revisions, Studio.
  {
    const fid = m.createDraft({ source: 'editor', userId: user, fields: { title: 'Synthetic fit story', author: 'Synthetic Editor', section: 'news', area: 'conference', body: 'Synthetic fit body text.' } });
    const fp = addPhoto(fid, 'Synthetic tall photo', 99);
    assert.deepEqual([fp.fit, fp.fitFill], ['cover', 'blur'], 'new photos default to cover and a blur fill');
    assert.throws(() => db.prepare("UPDATE draft_photos SET fit='stretch' WHERE id=?").run(fp.id), /CHECK constraint/);
    assert.throws(() => db.prepare("UPDATE draft_photos SET fit_fill='red' WHERE id=?").run(fp.id), /CHECK constraint/);
    const fitSave = (entries) => {
      const f = new FormData();
      for (const [k, v] of entries) f.append(`photo_${fp.id}_${k}`, v);
      const r = m.readDraftFields(f);
      return { r, saved: m.saveDraft(fid, m.getDraft(fid).updatedAt, { ...m.getDraft(fid) }, new Map(), user, null, r.photoFocus) };
    };
    const hidden = [['fit', 'cover']];
    const first = fitSave([...hidden, ['fit', 'contain'], ['fitFill', 'navy']]);
    assert.deepEqual(first.r.photoFocus.get(fp.id), { fit: 'contain', fitFill: 'navy' }, 'the checkbox value after the hidden cover wins');
    assert.equal(first.saved.ok, true);
    assert.equal(fitSave([]).r.photoFocus.size, 0, 'an older form without the fields sends nothing');
    assert.deepEqual([m.listPhotos(fid)[0].fit, m.listPhotos(fid)[0].fitFill], ['contain', 'navy']);
    assert.equal(m.saveDraft(fid, m.getDraft(fid).updatedAt, { ...m.getDraft(fid) }, new Map(), user).ok, true);
    assert.deepEqual([m.listPhotos(fid)[0].fit, m.listPhotos(fid)[0].fitFill], ['contain', 'navy'], 'an older save preserves fit and fill');
    for (const bad of [[['fit', 'sideways']], [['fit', 'cover'], ['fitFill', 'purple']]]) assert.throws(() => fitSave(bad), /fit/i);
    const pub1 = await m.publishDraft(m.getDraft(fid), m.listPhotos(fid), m.getDraft(fid).updatedAt, user);
    const live1 = m.getStoryBySlug(pub1.slug);
    assert.deepEqual([live1.photoRows[0].fit, live1.photoRows[0].fitFill], ['contain', 'navy'], 'publishing copies fit to story_photos');
    const loadedFit = m.loadStory(pub1.slug);
    assert.deepEqual([loadedFit.photos[0].fit, loadedFit.photos[0].fitFill], ['contain', 'navy']);
    m.reloadDraftFromStory(fid, user, loadedFit.fields, loadedFit.photos);
    assert.deepEqual([m.listPhotos(fid)[0].fit, m.listPhotos(fid)[0].fitFill], ['contain', 'navy'], 'Edit (reopen into a draft) keeps fit');
    const pub2 = await m.publishDraft(m.getDraft(fid), m.listPhotos(fid), m.getDraft(fid).updatedAt, user);
    const live2 = m.getStoryBySlug(pub2.slug);
    assert.deepEqual([live2.photoRows[0].fit, live2.photoRows[0].fitFill], ['contain', 'navy'], 'republishing keeps fit');
    // Revisions keep fit: switch to cover (records the contain state), then restore it.
    const again = m.loadStory(pub2.slug);
    m.reloadDraftFromStory(fid, user, again.fields, again.photos);
    assert.equal(fitSave([['fit', 'cover'], ['fitFill', 'paper']]).saved.ok, true);
    assert.deepEqual([m.listPhotos(fid)[0].fit, m.listPhotos(fid)[0].fitFill], ['cover', 'paper']);
    const fitRevision = m.listDraftRevisions(fid)[0].id;
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM draft_revisions WHERE id=?').get(fitRevision).payload).photos[0].fit, 'contain', 'the revision whitelist records fit');
    assert.equal(m.restoreDraftRevision(fid, m.getDraft(fid).updatedAt, fitRevision, user).ok, true);
    assert.deepEqual([m.listPhotos(fid)[0].fit, m.listPhotos(fid)[0].fitFill], ['contain', 'navy'], 'restoring a revision keeps fit and fill');
    // A revision from before migration 027 has no fit: restoring it gives the defaults (only the editor form preserves on omission).
    const oldPayload = JSON.parse(db.prepare('SELECT payload FROM draft_revisions WHERE id=?').get(fitRevision).payload);
    for (const p of oldPayload.photos) { delete p.fit; delete p.fitFill; }
    db.prepare('UPDATE draft_revisions SET payload=? WHERE id=?').run(JSON.stringify(oldPayload), fitRevision);
    assert.equal(m.restoreDraftRevision(fid, m.getDraft(fid).updatedAt, fitRevision, user).ok, true);
    assert.deepEqual([m.listPhotos(fid)[0].fit, m.listPhotos(fid)[0].fitFill], ['cover', 'blur'], 'restoring a pre-027 revision defaults to cover and blur');
    // The private preview's blur background obeys the same allow-list as <img src>.
    const own = m.restrictPreviewImages(m.renderInlinePhoto({ src: 'https://own.invalid/a.png', alt: 'x', fit: 'contain', fitFill: 'blur' }, true), ['own.invalid']);
    assert.ok(!/--fit-src/.test(own) && !/<img/.test(own), 'a refused preview image leaves no --fit-src');
    const okPreview = m.restrictPreviewImages(m.renderInlinePhoto({ src: '/api/admin/photos/3', alt: 'x', fit: 'contain', fitFill: 'blur' }, true), ['own.invalid']);
    assert.ok(/--fit-src:url\(/.test(okPreview) && /<img/.test(okPreview), 'an allowed preview image keeps its blur');
    const forged = m.restrictPreviewImages('<a data-fit="contain" style="--fit-src:url(&quot;/admin/secret.png&quot;);"><img src="/api/admin/photos/3" alt=""></a>', []);
    assert.ok(!/--fit-src/.test(forged) && /<img/.test(forged), 'a --fit-src outside the allow-list is dropped');
    // Studio publish: with and without the fields.
    const sa = { url: pngData(52), alt: 'Synthetic fit A', caption: '' };
    const s1 = await sendStudio(studioRequest([sa], 'Synthetic Studio fit'));
    const sslug = s1.stories[0].slug;
    const fitOf = () => m.getStoryBySlug(sslug).photoRows.map((p) => [p.fit, p.fitFill]);
    assert.deepEqual(fitOf(), [['cover', 'blur']], 'Studio without the fields uses the defaults');
    await sendStudio(studioRequest([{ ...sa, fit: 'contain', fitFill: 'paper' }], 'Synthetic Studio fit'));
    assert.deepEqual(fitOf(), [['contain', 'paper']], 'Studio sets fit and fill');
    await sendStudio(studioRequest([sa], 'Synthetic Studio fit'));
    assert.deepEqual(fitOf(), [['contain', 'paper']], 'omitting the fields preserves the stored fit for the same photo');
    await sendStudio(studioRequest([{ ...sa, fit: 'cover' }], 'Synthetic Studio fit'));
    assert.deepEqual(fitOf(), [['cover', 'paper']], 'an explicit cover resets the fit; the fill is preserved');
    for (const bad of [{ fit: 'zoom' }, { fit: null }, { fitFill: 'red' }, { fitFill: 3 }]) assert.throws(() => m.prepareStudioPublish(studioRequest([{ ...sa, ...bad }], 'Synthetic Studio fit')), /fit/i);
    console.log('PASS fit whole photo: form parsing, older-form preservation, publish, reopen, republish, revision restore, Studio with and without fields');
  }
  console.log('PASS persisted revisions: privacy, retention20, unchanged saves, draft scope, conflicts, atomic restore/audit, failure cleanup, ID reuse and inert marker examples');
  console.log('PASS modules and Studio crop compatibility: migration, legacy save, conflicts, publish/reopen, validation, identity/reorder, partial omissions, races, open drafts and rollback');
} finally {
  db?.close();
  delete globalThis.__storyBuilderTestDb;
  fs.rmSync(bundle, { force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
}
