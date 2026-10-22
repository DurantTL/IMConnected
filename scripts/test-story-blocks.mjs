#!/usr/bin/env node
// Focused contract and safety checks for the modular story editor. No server, database or external service is used.
// Run from the repository root: node scripts/test-story-blocks.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from '../node_modules/rolldown/dist/index.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-block-tests-'));
let count = 0;
const check = (name, fn) => { fn(); count++; console.log(`PASS ${name}`); };
try {
  const require = createRequire(import.meta.url);
  await build({ input: { schema: 'src/lib/story-blocks.ts', render: 'src/lib/story-block-render.ts', media: 'src/lib/story-media-render.ts', excerpt: 'src/lib/excerpt.ts', search: 'src/lib/search.ts', index: 'src/lib/search-index.ts' }, output: { dir: scratch, format: 'esm' }, platform: 'node', logLevel: 'silent', plugins: [{ name: 'keep-markdown-native-binding', resolveId(id) { if (id === '@astrojs/markdown-satteri') return { id: require.resolve(id), external: true }; } }] });
  const { normalizeStoryBlocks, parseStoryBlocks, blocksToMarkdown, photoFocusStyle, photoZoom, escapeStoryBlocks, assertOwnStoryImages, splitMarkdownIntoModules, checkStoryBlockLength, isStoryImageUrl } = await import(pathToFileURL(path.join(scratch, 'schema.js')));
  const { renderStoryBlocksSafe } = await import(pathToFileURL(path.join(scratch, 'render.js')));
  const { renderMediaMarkdown } = await import(pathToFileURL(path.join(scratch, 'media.js')));
  const { storyExcerpt } = await import(pathToFileURL(path.join(scratch, 'excerpt.js')));
  const { toHit } = await import(pathToFileURL(path.join(scratch, 'search.js')));
  const { indexStory } = await import(pathToFileURL(path.join(scratch, 'index.js')));
  const { DatabaseSync } = await import('node:sqlite');
  const mediaPhotos = [{ src: '/media/stories/synthetic/a.png', alt: 'Synthetic <scene>', focalX: 0, focalY: 100, zoom: 2 }, { src: '/media/stories/synthetic/b.png', alt: '' }];
  const inline = await renderMediaMarkdown('Before **bold**.\n{{photo 1}}\nAfter.', mediaPhotos);
  check('standalone photo markers split paragraph boundaries safely and keep the crop/viewer', () => {
    assert.match(inline.html, /<strong>bold<\/strong>/); assert.match(inline.html, /class="story-inline-photo"/); assert.match(inline.html, /alt="Synthetic &lt;scene&gt;"/); assert.match(inline.html, /scale:2/); assert.match(inline.html, /data-photo/); assert.deepEqual([...inline.used], [0]); assert.doesNotMatch(inline.html, /\{\{photo|<p>\s*<figure/);
  });
  const codeExamples = await renderMediaMarkdown('`{{photo 1}}`\n\n```text\n{{photo 2}}\n```\n\nA `multi\n{{photo 1}}\nline` code span.\n\n[{{photo 1}}](https://example.invalid/)', mediaPhotos);
  check('code spans, fences and linked marker-like text stay inert', () => { assert.equal(codeExamples.used.size, 0); assert.doesNotMatch(codeExamples.html, /story-inline-photo/); assert.match(codeExamples.html, /\{\{photo 1\}\}/); });
  for (const marker of ['{{photo 99}}', '{{photo -1}}', '{{photo <script>}}', '{{photo 0}}', '{{photo 999999999999999999}}', '{{photo 1', '{{photo 1}']) {
    const publicResult = await renderMediaMarkdown(marker, mediaPhotos);
    const previewResult = await renderMediaMarkdown(marker, mediaPhotos, true);
    check(`invalid marker is hidden publicly and warns safely in preview: ${marker}`, () => { assert.equal(publicResult.used.size, 0); assert.equal(publicResult.html, ''); assert.match(previewResult.html, /story-media-warning/); assert.doesNotMatch(previewResult.html, /<script/); });
  }
  const isolated = await Promise.all([renderMediaMarkdown('{{photo 1}}', mediaPhotos), renderMediaMarkdown('{{photo 2}}', mediaPhotos)]);
  check('concurrent renderer requests do not share photo state', () => { assert.deepEqual([...isolated[0].used], [0]); assert.deepEqual([...isolated[1].used], [1]); });
  check('derived excerpts skip marker-only paragraphs and marker fragments', () => { assert.equal(storyExcerpt('{{photo 1}}\n\nSynthetic article text.'), 'Synthetic article text.'); assert.equal(storyExcerpt('Before {{photo 99}} after.'), 'Before after.'); });
  const duplicates = await renderMediaMarkdown('{{photo 2}}', [mediaPhotos[0], { ...mediaPhotos[0], alt: 'Second slot', zoom: 3 }]);
  check('duplicate image addresses still refer to distinct ordered photo slots', () => { assert.deepEqual([...duplicates.used], [1]); assert.match(duplicates.html, /alt="Second slot"/); assert.match(duplicates.html, /scale:3/); });
  for (const prose of ['{{photo 1}} This happened next.', '{{photo note}} Keep sentence.']) {
    const result = await renderMediaMarkdown(prose, mediaPhotos);
    check('marker-like prose is preserved literally: ' + prose, () => { assert.equal(result.used.size, 0); assert.ok(result.html.includes(prose)); });
  }
  check('malformed marker fragments do not leak into derived text', () => { assert.equal(storyExcerpt('Before {{photo 1}'), 'Before'); assert.equal(storyExcerpt('{{photo 1}oops\n\nNext paragraph.'), 'oops'); assert.equal(storyExcerpt('{{photo note} Keep sentence.'), 'Keep sentence.'); });
  check('search strips markers from both indexed summaries and displayed snippets', () => {
    const dek = 'Synthetic {{photo 1}} summary {{photo 2}';
    const hit = toHit({ slug: 'sample', title: 'Sample', section: 'news', date: '2026-01-01', author: 'Synthetic', body: 'Body.', dek }, ['synthetic']);
    assert.doesNotMatch(hit.snippet, /photo|[{}]/);
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE stories_fts USING fts5(title, dek, author, church, body, stamp UNINDEXED)');
      indexStory(db, 1, { title: 'Sample', author: 'Synthetic', body: '{{photo 1}}\n\nBody.', dek }, 1);
      const row = db.prepare('SELECT dek, body FROM stories_fts').get();
      assert.equal(row.dek, 'Synthetic summary'); assert.equal(row.body, 'Body.');
    } finally { db.close(); }
  });
  check('legacy absence is an empty module list', () => assert.deepEqual(normalizeStoryBlocks(undefined), []));
  check('IDs must be stable and unique', () => assert.throws(() => normalizeStoryBlocks([{ id: 'same', type: 'text' }, { id: 'same', type: 'divider' }])));
  check('unknown module types are rejected', () => assert.throws(() => normalizeStoryBlocks([{ id: 'html', type: 'raw-html' }])));
  check('excessive module counts are rejected', () => assert.throws(() => normalizeStoryBlocks(Array.from({ length: 61 }, (_, i) => ({ id: `b${i}`, type: 'divider' })))));
  check('invalid JSON is not silently discarded', () => assert.throws(() => parseStoryBlocks('{bad')));
  check('script and relative button URLs are rejected', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,abc', '//example.test', 'https://user:password@example.test']) assert.throws(() => normalizeStoryBlocks([{ id: 'button', type: 'button', url }]));
  });
  check('image sources cannot use traversal, protected endpoints or data HTML', () => {
    for (const url of ['/media/stories/../secret.jpg', '/media/stories/%2e%2e/secret.jpg', '/api/admin/photos/1', 'data:text/html,<script>']) assert.throws(() => normalizeStoryBlocks([{ id: 'photo', type: 'image', url }]));
  });
  check('focal values keep zero and reject out-of-range input', () => {
    assert.equal(photoFocusStyle({ focalX: 0, focalY: 100 }), 'object-position:0% 100%;');
    assert.equal(photoFocusStyle({ focalX: 50, focalY: 50 }), undefined);
    assert.throws(() => normalizeStoryBlocks([{ id: 'photo', type: 'image', focalX: 101 }]));
  });
  check('zoom defaults preserve old photos and reject invalid or injectable values', () => {
    assert.equal(photoZoom(undefined), 1);
    assert.equal(photoZoom('1.876'), 1.88);
    assert.equal(photoZoom(3), 3);
    for (const zoom of [0, .99, 3.01, Infinity, NaN, '2;display:none', true, {}]) {
      assert.throws(() => photoZoom(zoom), /between 100% and 300%/);
      assert.throws(() => normalizeStoryBlocks([{ id: 'bad-zoom', type: 'image', zoom }]), /between 100% and 300%/);
    }
    assert.equal(photoFocusStyle({ focalX: 0, focalY: 100, zoom: 2 }), 'object-position:0% 100%;scale:2;transform-origin:0% 100%;');
  });
  const blocks = [
    { id: 'intro', type: 'text', text: 'First **bold** paragraph. <script>alert(1)</script>' },
    { id: 'heading', type: 'heading', level: 3, text: '<img src=x onerror=alert(1)>' },
    { id: 'quote', type: 'quote', text: 'Synthetic quote.' },
    { id: 'list', type: 'list', items: ['First item', '<script>second</script>'] },
    { id: 'image', type: 'image', url: '/media/stories/sample/abc.jpg', alt: 'Sample "photo"', focalX: 0, focalY: 100, zoom: 1.8 },
    { id: 'button', type: 'button', label: 'Read more', url: 'https://example.test/details?a=1&b=2' },
    { id: 'divider', type: 'divider' },
  ];
  const html = await renderStoryBlocksSafe(blocks);
  check('modules render in saved order', () => {
    const order = blocks.map((b) => html.indexOf(`data-module-id="${b.id}"`));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])));
  });
  check('text Markdown formatting renders while raw HTML stays inert', () => {
    assert.match(html, /<strong>bold<\/strong>/);
    assert.doesNotMatch(html, /<script|<img src=x/);
    assert.match(html, /&lt;img src=x onerror/);
  });
  check('image focus, escaped alt and normalized action URL survive output', () => {
    assert.match(html, /object-position:0% 100%/);
    assert.match(html, /scale:1.8;transform-origin:0% 100%/);
    assert.match(html, /overflow:hidden/);
    assert.match(html, /alt="Sample &quot;photo&quot;"/);
    assert.match(html, /href="https:\/\/example.test\/details\?a=1&amp;b=2"/);
  });
  check('search projection keeps textual module content', () => {
    const markdown = blocksToMarkdown(blocks);
    for (const text of ['First **bold**', 'Synthetic quote', 'First item', 'Read more']) assert.ok(markdown.includes(text));
    assert.ok(markdown.indexOf('Synthetic quote') < markdown.indexOf('Read more'));
  });
  check('an image module adds nothing to the Markdown projection (no alt-text paragraph)', () => {
    assert.equal(blocksToMarkdown([{ id: 'only', type: 'image', url: '/media/stories/sample/abc.jpg', alt: 'A distinctive alt phrase' }]), '');
    const md = blocksToMarkdown([{ id: 'a', type: 'text', text: 'Before.' }, { id: 'i', type: 'image', url: '/media/stories/sample/abc.jpg', alt: 'A distinctive alt phrase' }, { id: 'b', type: 'text', text: 'After.' }]);
    assert.equal(md, 'Before.\n\nAfter.');
  });
  check('image modules accept only a story\'s own photo paths, never an external address', () => {
    for (const url of ['https://example.test/photo.jpg', 'http://example.test/photo.jpg', '//example.test/photo.jpg', '/images/other.jpg', '/media/other/photo.jpg']) {
      assert.equal(isStoryImageUrl(url), false, url);
      assert.throws(() => normalizeStoryBlocks([{ id: 'photo', type: 'image', url }]), /own photos/);
    }
    assert.equal(isStoryImageUrl('/media/stories/s/abc.jpg'), true);
    assert.equal(isStoryImageUrl('/images/stories/s/photo-1.jpg'), true);
  });
  check('assertOwnStoryImages refuses an address that is not one of the story\'s photos', () => {
    const modules = normalizeStoryBlocks([{ id: 'photo', type: 'image', url: '/media/stories/s/abc.jpg' }]);
    assert.doesNotThrow(() => assertOwnStoryImages(modules, ['/media/stories/s/abc.jpg']));
    assert.throws(() => assertOwnStoryImages(modules, ['/media/stories/s/other.jpg']), /own photos/);
    assert.throws(() => assertOwnStoryImages(modules, []), /own photos/);
  });
  const hostile = '<script>alert(1)</script> & <img src=x onerror=alert(1)>';
  const stored = escapeStoryBlocks(normalizeStoryBlocks([
    { id: 'p', type: 'text', text: hostile }, { id: 'h', type: 'heading', text: hostile }, { id: 'l', type: 'list', items: [hostile] },
    { id: 'q', type: 'quote', text: hostile }, { id: 'i', type: 'image', url: '/media/stories/s/abc.jpg', alt: hostile }, { id: 'b', type: 'button', label: hostile, url: 'https://example.test/' },
  ]));
  check('stored module text never contains "<" (same contract as the body) and escaping twice changes nothing', () => {
    assert.ok(!JSON.stringify(stored).includes('<'));
    assert.deepEqual(escapeStoryBlocks(stored), stored);
  });
  const storedHtml = await renderStoryBlocksSafe(stored);
  check('escaped modules show their text literally: no element, no double-escaped entity', () => {
    assert.doesNotMatch(storedHtml, /<script|<img src=x/);
    assert.doesNotMatch(storedHtml, /&amp;lt;|&amp;amp;/);
    assert.equal((storedHtml.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &lt;img src=x onerror=alert\(1\)&gt;/g) || []).length, 6, 'paragraph, quote, heading, list item, button label and alt all carry the text once');
    assert.match(storedHtml, /alt="&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &lt;img src=x onerror=alert\(1\)&gt;"/);
  });
  check('the Markdown projection of escaped headings and list items has no backslash before &lt;', () => {
    assert.doesNotMatch(blocksToMarkdown(stored), /\\&lt;/);
    assert.doesNotMatch(blocksToMarkdown(normalizeStoryBlocks([{ id: 'h', type: 'heading', text: 'a <b> c' }])), /\\</);
  });
  check('button addresses cannot carry markup characters', () => {
    for (const url of ['https://example.test/<x>', 'https://example.test/"x']) assert.throws(() => normalizeStoryBlocks([{ id: 'b', type: 'button', url }]));
  });
  check('module text together is limited to the 20,000-character body limit, with a clear message', () => {
    assert.throws(() => checkStoryBlockLength(normalizeStoryBlocks([{ id: 'a', type: 'text', text: 'x'.repeat(15_000) }, { id: 'b', type: 'text', text: 'y'.repeat(15_000) }])), /up to 20,000 characters/);
    assert.doesNotThrow(() => checkStoryBlockLength(normalizeStoryBlocks([{ id: 'a', type: 'text', text: 'x'.repeat(15_000) }])));
  });
  check('Use modules splits long Markdown between paragraphs, never inside a link', () => {
    const para = (n) => `Paragraph ${n} with a [link text here](https://example.test/page-${n}) in it. ` + 'word '.repeat(299) + 'word';
    const md = Array.from({ length: 30 }, (_, n) => para(n)).join('\n\n');
    const parts = splitMarkdownIntoModules(md);
    assert.ok(parts.length > 1 && parts.every((p) => p.length <= 20_000));
    for (const p of parts) assert.ok(p.startsWith('Paragraph ') && !/\[link text here\]\([^)]*$/.test(p) && (p.match(/\[/g) || []).length === (p.match(/\]\(/g) || []).length);
    assert.equal(parts.join('\n\n'), md);
  });
  const preview = await renderStoryBlocksSafe([{ id: 'draft-photo', type: 'image', photoId: 17 }], { resolvePhoto: (id) => id === 17 ? { url: '/api/admin/photos/17', alt: 'Synthetic photo', focalX: 25, focalY: 75, zoom: 2 } : undefined });
  check('only a trusted preview resolver can expose an editor image', () => {
    assert.match(preview, /src="\/api\/admin\/photos\/17"/);
    assert.match(preview, /object-position:25% 75%/);
    assert.match(preview, /scale:2;transform-origin:25% 75%/);
  });
  const unresolved = await renderStoryBlocksSafe([{ id: 'unresolved', type: 'image', photoId: 17 }]);
  check('an unresolved draft image is not leaked in public output', () => assert.equal(unresolved, ''));
  const emptyAlt = await renderStoryBlocksSafe([{ id: 'empty-alt', type: 'image', url: '/media/stories/sample/abc.jpg', alt: '' }]);
  check('an image without alt text keeps a named enlargement link without inventing a description', () => {
    assert.match(emptyAlt, /<a [^>]*aria-label="Enlarge story photo"/);
    assert.match(emptyAlt, /alt=""/);
  });
  console.log(`\n${count} story module checks passed.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
