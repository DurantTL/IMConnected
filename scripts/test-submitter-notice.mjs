#!/usr/bin/env node
// End-to-end check of the "your story is published" email to a confirmed form submitter (issue #121). It starts its own
// copy of the BUILT server against a throwaway data folder and a local mock of the Resend endpoint. Synthetic data only:
// example.test addresses, made-up secrets, no real email.
//   npm run build
//   DATA_DIR=$(mktemp -d) PORT=4391 MAIL_PORT=4392 NO_PROXY=localhost,127.0.0.1 node scripts/test-submitter-notice.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
if (!process.env.DATA_DIR) throw new Error('Set DATA_DIR to a throwaway data folder.');
const DATA_DIR = path.resolve(process.env.DATA_DIR);
fs.mkdirSync(DATA_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 4391);
const MAIL_PORT = Number(process.env.MAIL_PORT || 4392);
const BASE = `http://localhost:${PORT}`;
const DB_FILE = path.join(DATA_DIR, 'imconnected.db');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
const run = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).run(...args); } finally { db.close(); } };

// ---- the mock email service ----
const mails = [];
let mailStatus = 200;
const mailServer = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  try { mails.push(JSON.parse(raw)); } catch { mails.push({ bad: raw }); }
  res.writeHead(mailStatus, { 'Content-Type': 'application/json' }); res.end('{"id":"mock"}');
}).listen(MAIL_PORT);

const env = { ...process.env, DATA_DIR, PORT: String(PORT), SITE_URL: BASE, AUTH_SECRET: 'synthetic-auth-secret-0123456789abcdef', TRUST_PROXY: 'true',
  RESEND_API_KEY: 'mock-resend-key', EMAIL_FROM: 'IMConnected <noreply@example.test>', EMAIL_API_URL: `http://localhost:${MAIL_PORT}/emails` };
delete env.PUBLISH_TOKEN;
const server = spawn('node', ['dist/server/entry.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* already stopped */ } try { mailServer.close(); } catch { /* already stopped */ } };
process.on('exit', stop);
for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/admin/login'); break; } catch { await sleep(200); } }

const now = Date.now();
const uid = Number(run("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES ('notice-editor@example.test', 'Notice Editor', 'editor', 'active', ?, ?)", now, now).lastInsertRowid);
const token = randomBytes(32).toString('base64url');
run('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed) VALUES (?, ?, ?, ?, ?, 1)', createHash('sha256').update(token).digest('hex'), uid, now, now, now + 3600_000);
const cookie = `__Host-imc_session=${token}`;
const post = async (url, fields) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, String(x));
  const res = await fetch(BASE + url, { method: 'POST', headers: { Cookie: cookie, Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  return { status: res.status, loc: res.headers.get('location'), text: await res.text() };
};
const draftRow = (id) => q('SELECT * FROM drafts WHERE id = ?', id)[0];
const idOf = (r) => Number(/\/admin\/drafts\/(\d+)/.exec(r.loc || '')?.[1]);
const fields = (title) => ({ title, dek: 'A short synthetic summary.', section: 'news', area: 'churches', column: '', author: 'Pat Example', authorTitle: '', church: 'Example Hills Church', date: '2026-10-19', photoCredit: '', featured: '', body: 'Synthetic story text for the notice test.' });
/** A draft as the public form would leave it (source and address set directly; the form itself has its own test). */
async function mkDraft(title, { source = 'form', verified = 1, email = 'riley.sample@example.test' } = {}) {
  const r = await post('/api/admin/drafts/new', {});
  const id = idOf(r);
  const s = await post(`/api/admin/drafts/${id}/save`, { version: draftRow(id).updated_at, ...fields(title) });
  if (s.status !== 200) throw new Error(`could not save the draft: ${s.status}`);
  run('UPDATE drafts SET source = ?, email_verified = ?, submitter_email = ?, submitter_phone = ?, submitter_name = ? WHERE id = ?', source, verified, email, '555-0142', 'Riley Sample', id);
  return id;
}
const publish = (id) => post(`/api/admin/drafts/${id}/publish`, { version: draftRow(id).updated_at });
const auditFor = (action, id) => q('SELECT detail, target FROM audit_log WHERE action = ? AND target = ?', action, `draft:${id}`);
const settle = () => sleep(300);

try {
  // ---- one email on the first publish, with the link and the escaped title ----
  const HOSTILE = '<script>alert(1)</script> Notice One';
  const A = await mkDraft(HOSTILE);
  mails.length = 0;
  let r = await publish(A);
  await settle();
  const slugA = draftRow(A).slug;
  check('publishing a confirmed form draft succeeds', r.status === 303 && draftRow(A).status === 'published' && !!slugA, `${r.status} ${r.loc}`);
  check('exactly one email was sent, to the submitter only', mails.length === 1 && mails[0].to?.length === 1 && mails[0].to[0] === 'riley.sample@example.test', JSON.stringify(mails.map((m) => m.to)));
  const m = mails[0] || {};
  check('it carries the live story link', (m.text || '').includes(`${BASE}/stories/${slugA}/`) && (m.html || '').includes(`href="${BASE}/stories/${slugA}/"`));
  check('the title is escaped in the HTML and literal in the text', (m.html || '').includes('&lt;script&gt;alert(1)&lt;/script&gt; Notice One') && !(m.html || '').includes('<script>') && (m.text || '').includes(HOSTILE));
  check('it holds no phone number, name or other contact detail', !/555-0142|Riley|Pat Example|Example Hills/.test(`${m.text}${m.html}${m.subject}`));
  console.log('--- subject:', m.subject, '\n--- text:\n' + m.text + '\n---');
  check('the draft is marked and the audit notes it by draft id only', draftRow(A).submitter_notified_at > 0 && auditFor('draft.submitter_notified', A).length === 1 && !/riley|example\.test/i.test(JSON.stringify(q('SELECT * FROM audit_log WHERE target = ?', `draft:${A}`))));

  // ---- not again: publishing again, or unpublish then republish ----
  mails.length = 0;
  r = await publish(A);
  check('publishing the already published draft again is refused and sends nothing', draftRow(A).status === 'published' && mails.length === 0, `${r.status}`);
  const un = await post('/admin/bulk', { action: 'unpublish', step: 'run', slug: [slugA] });
  check('(setup) the story was unpublished', un.status === 200 && draftRow(A).status === 'in_review', String(un.status));
  r = await publish(A);
  await settle();
  check('republishing after an unpublish publishes but sends no second email', draftRow(A).status === 'published' && mails.length === 0 && auditFor('draft.submitter_notified', A).length === 1, `mails=${mails.length}`);
  const claimAgain = run("UPDATE drafts SET submitter_notified_at = ? WHERE id = ? AND source = 'form' AND email_verified = 1 AND submitter_email IS NOT NULL AND submitter_notified_at IS NULL", Date.now(), A);
  check('the marker can only be claimed once', Number(claimAgain.changes) === 0);

  // ---- none when unconfirmed, agent, studio or editor ----
  mails.length = 0;
  const U = await mkDraft('Notice Unconfirmed', { verified: 0 });
  const G = await mkDraft('Notice Agent Draft', { source: 'agent' });
  const S = await mkDraft('Notice Studio Draft', { source: 'studio' });
  const E = await mkDraft('Notice Editor Draft', { source: 'editor' });
  for (const id of [U, G, S, E]) await publish(id);
  await settle();
  check('unconfirmed, agent, studio and editor drafts all publish and send nothing', [U, G, S, E].every((id) => draftRow(id).status === 'published') && mails.length === 0 && !q("SELECT 1 FROM audit_log WHERE action LIKE 'draft.submitter_notif%' AND target IN (?, ?, ?, ?)", `draft:${U}`, `draft:${G}`, `draft:${S}`, `draft:${E}`).length, `mails=${mails.length}`);
  check('an unconfirmed draft stays unmarked', draftRow(U).submitter_notified_at === null);

  // ---- bulk publish: one per item ----
  mails.length = 0;
  const B1 = await mkDraft('Notice Bulk One', { email: 'bulk.one@example.test' });
  const B2 = await mkDraft('Notice Bulk Two', { email: 'bulk.two@example.test' });
  const B3 = await mkDraft('Notice Bulk Three', { verified: 0, email: 'bulk.three@example.test' });
  const bf = { action: 'publish', step: 'run', id: [B1, B2, B3] };
  for (const id of [B1, B2, B3]) bf[`v_${id}`] = draftRow(id).updated_at;
  r = await post('/admin/bulk', bf);
  await settle();
  const to = mails.flatMap((x) => x.to).sort();
  check('bulk publish sends one email per confirmed form item', r.status === 200 && mails.length === 2 && to.join() === 'bulk.one@example.test,bulk.two@example.test', JSON.stringify(to));
  check('each bulk email links its own story', [B1, B2].every((id) => mails.some((x) => x.text.includes(`/stories/${draftRow(id).slug}/`))));
  r = await post('/admin/bulk', bf);
  await settle();
  check('re-running the same bulk publish sends nothing more', mails.length === 2, `mails=${mails.length}`);

  // ---- a failing mail service never blocks the publish ----
  mails.length = 0;
  mailStatus = 500;
  const F = await mkDraft('Notice Mail Failure', { email: 'failing@example.test' });
  r = await publish(F);
  await settle();
  check('with the email service answering 500 the story is still published', r.status === 303 && draftRow(F).status === 'published' && q('SELECT 1 FROM stories WHERE slug = ?', draftRow(F).slug).length === 1);
  check('the failure is audited by draft id, without the address, and not retried', mails.length === 1 && auditFor('draft.submitter_notify_failed', F).length === 1 && !/failing@|example\.test/.test(JSON.stringify(q("SELECT * FROM audit_log WHERE action = 'draft.submitter_notify_failed'"))));
  mailStatus = 200;

  // ---- no address in the server log ----
  const log = serverLog.join('');
  check('the server log never holds a submitter address', !/riley\.sample@|bulk\.(one|two|three)@|failing@/.test(log));
} finally {
  stop();
}
console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
if (fails) { console.log(serverLog.join('').slice(-1500)); process.exit(1); }
