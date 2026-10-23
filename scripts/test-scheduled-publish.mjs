#!/usr/bin/env node
// End-to-end check of scheduled publishing (issue #124) and the AI agent's suggested publish time. It starts TWO copies of the
// BUILT server on the same throwaway data folder (so the claim that stops a double publish is really raced), with a
// fast scheduler tick. Synthetic data only: made-up tokens, no email, no GitHub, nothing real.
//   npm run build
//   DATA_DIR=$(mktemp -d) PORT=4393 NO_PROXY=localhost,127.0.0.1 node scripts/test-scheduled-publish.mjs
// Uses PORT and PORT+1. Run from the repo root.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
if (!process.env.DATA_DIR) throw new Error('Set DATA_DIR to a throwaway data folder.');
const DATA_DIR = path.resolve(process.env.DATA_DIR);
fs.mkdirSync(DATA_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 4393);
const PORT_B = PORT + 1;
const BASE = `http://localhost:${PORT}`;
const BASE_B = `http://localhost:${PORT_B}`;
const DB_FILE = path.join(DATA_DIR, 'imconnected.db');
const AGENT_TOKEN = 'made-up-agent-token-for-scheduling-' + 'a'.repeat(16);

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
const run = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).run(...args); } finally { db.close(); } };
async function until(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; }

// ---- two servers on the same data ----
const baseEnv = { ...process.env, DATA_DIR, SCHEDULE_CHECK_MS: '300', SCHEDULE_START_DELAY_MS: '0', AUTH_SECRET: 'synthetic-auth-secret-0123456789abcdef', TRUST_PROXY: 'true', AGENT_API_TOKEN: AGENT_TOKEN, PUBLISH_TOKEN: 'made-up-publish-token-0123456789abcdef' };
delete baseEnv.RESEND_API_KEY;
const servers = [];
const serverLog = [];
function startServer(port) {
  const s = spawn('node', ['dist/server/entry.mjs'], { env: { ...baseEnv, PORT: String(port), SITE_URL: `http://localhost:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  s.stdout.on('data', (d) => serverLog.push(String(d)));
  s.stderr.on('data', (d) => serverLog.push(String(d)));
  servers.push(s);
  return s;
}
const stop = () => { for (const s of servers) { try { s.kill(); } catch { /* gone */ } } };
process.on('exit', stop);
const ready = async (base) => { for (let i = 0; i < 150; i++) { try { await fetch(base + '/admin/login'); return; } catch { await sleep(200); } } };
// The scheduler must never start during `npm run build` (issue #124): build against a data folder that does not exist and
// assert the build neither created it nor a database. (Skipped with SKIP_BUILD_CHECK=1.)
if (!process.env.SKIP_BUILD_CHECK) {
  const ghost = path.join(path.dirname(DATA_DIR), 'ghost-build-data-' + process.pid);
  try { execFileSync('npm', ['run', 'build'], { env: { ...process.env, DATA_DIR: ghost }, stdio: 'ignore', timeout: 300000 }); } catch (err) { console.log('build failed', err.message); }
  check('npm run build with a non-existent DATA_DIR creates neither the folder nor a database (no scheduler or db start at build)', !fs.existsSync(ghost));
}
startServer(PORT);
await ready(BASE);

const mkUser = (email, name, role) => {
  const now = Date.now();
  const id = Number(run("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)", email, name, role, now, now).lastInsertRowid);
  const token = randomBytes(32).toString('base64url');
  run('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed) VALUES (?, ?, ?, ?, ?, 1)', createHash('sha256').update(token).digest('hex'), id, now, now, now + 3600_000);
  return { id, name, token };
};
const E1 = mkUser('sched-editor@example.test', 'Sched Editor', 'editor');
const E2 = mkUser('sched-second@example.test', 'Second Editor', 'editor');
const ADM = mkUser('sched-admin@example.test', 'Sched Admin', 'admin');
const E3 = mkUser('sched-leaver@example.test', 'Leaving Editor', 'editor');

class Client {
  constructor(user, base = BASE) { this.cookie = user ? `__Host-imc_session=${user.token}` : ''; this.base = base; }
  async req(method, url, body, headers = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (method !== 'GET' && h.Origin === undefined) h.Origin = this.base;
    const res = await fetch(this.base + url, { method, headers: h, body, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, loc: res.headers.get('location'), text };
  }
  get(u) { return this.req('GET', u); }
  form(u, fields, headers) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) body.append(k, String(v));
    return this.req('POST', u, body, { 'Content-Type': 'application/x-www-form-urlencoded', ...headers });
  }
}
const c1 = new Client(E1);
const c2 = new Client(E2);
const anon = new Client(null);
const cB = new Client(E1, BASE_B);
const cAdm = new Client(ADM);
const c3 = new Client(E3);

const draftRow = (id) => q('SELECT * FROM drafts WHERE id = ?', id)[0];
const version = (id) => draftRow(id).updated_at;
const idOf = (r) => Number(/\/admin\/drafts\/(\d+)/.exec(r.loc || '')?.[1]);
const errOf = (r) => new URL(r.loc || '/', BASE).searchParams.get('e');
const noteOf = (r) => new URL(r.loc || '/', BASE).searchParams.get('n');
const baseFields = (over = {}) => ({ title: 'Scheduled Camp Meeting Update', dek: 'Volunteers are welcome.', section: 'news', area: 'churches', column: '', author: 'Pat Example', authorTitle: 'Volunteer', church: 'Example Hills Church', date: '2026-10-19', photoCredit: '', featured: '', body: 'Camp meeting is **coming up** and we need help.', ...over });
async function mkDraft(title, over = {}) {
  const r = await c1.form('/api/admin/drafts/new', {});
  const id = idOf(r);
  const s = await c1.form(`/api/admin/drafts/${id}/save`, { version: version(id), ...baseFields({ title, ...over }) });
  if (s.status !== 200) throw new Error(`could not save the synthetic draft ${title}: ${s.status} ${s.text.slice(0, 120)}`);
  return id;
}
const auditRows = (action, target) => q('SELECT * FROM audit_log WHERE action = ? AND target = ?', action, target);
// A datetime-local value in America/Chicago for an instant (independent of the code under test: Intl only).
const chicago = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
const schedule = (client, id, at, v = version(id)) => client.form(`/api/admin/drafts/${id}/schedule`, { version: v, publish_at: at });
const nextYear = new Date().getUTCFullYear() + 1;

const agent = async (method, url, json, base = BASE) => {
  const res = await fetch(base + url, { method, headers: { Authorization: `Bearer ${AGENT_TOKEN}`, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const text = await res.text();
  let data = {}; try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, text };
};
const story = (over = {}) => ({ title: 'Synthetic Pathfinder Campout Report', dek: 'Forty youth camped together.', body: 'Pathfinders gathered for a weekend of knot tying and worship.\n\nLeaders closed with a sunrise devotional.', section: 'youth', area: 'pathfinders', author: 'Staff Writer', church: 'Example Hills Church', date: '2026-10-12', ...over });
const isoIn = (ms, offset = '-05:00') => { // a future instant written with an explicit offset
  const t = Date.now() + ms;
  const shifted = new Date(t + (offset === 'Z' ? 0 : (offset.startsWith('-') ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) * 60000));
  return shifted.toISOString().replace(/\.\d{3}Z$/, offset === 'Z' ? 'Z' : offset);
};

try {
  // ================= migration =================
  {
    const cols = q('PRAGMA table_info(drafts)').map((c) => c.name);
    check('migration 035 added publish_at, publish_at_by, the claim, failure and suggestion columns', ['publish_at', 'publish_at_by', 'publish_claimed_at', 'publish_fail_count', 'publish_error', 'publish_error_at', 'suggested_publish_at'].every((c) => cols.includes(c)));
    check('...and the partial index on publish_at exists', q("SELECT 1 FROM sqlite_master WHERE name = 'drafts_publish_at'").length === 1);
  }

  // ================= schedule, unschedule, refusals =================
  const S = await mkDraft('Schedule Alpha Retreat Report');
  {
    const winter = `${nextYear}-01-15T09:00`; // CST (UTC-6) -> 15:00Z
    const summer = `${nextYear}-07-15T09:00`; // CDT (UTC-5) -> 14:00Z
    let r = await schedule(c1, S, winter);
    check('scheduling an open draft redirects back with the "scheduled" notice', noteOf(r) === 'scheduled', `${r.status} ${r.loc}`);
    check('a winter time entered in Central Time is stored as 15:00 UTC', draftRow(S).publish_at === Date.parse(`${nextYear}-01-15T15:00:00Z`), String(draftRow(S).publish_at));
    check('the scheduling editor is recorded', draftRow(S).publish_at_by === E1.id);
    r = await schedule(c1, S, summer);
    check('a summer time entered in Central Time is stored as 14:00 UTC (daylight saving)', draftRow(S).publish_at === Date.parse(`${nextYear}-07-15T14:00:00Z`), String(draftRow(S).publish_at));
    check('both schedulings are audited (draft.schedule) with no email or phone in the detail', auditRows('draft.schedule', `draft:${S}`).length === 2 && !auditRows('draft.schedule', `draft:${S}`).some((a) => /@|555/.test(a.detail || '')));
    const page = await c1.get(`/admin/drafts/${S}`);
    check('the draft shows "Scheduled for ... CT" in Central Time and the Publish now / Unschedule buttons', /Scheduled for[^<]*Jul 15, 2027|Scheduled for[^<]*Jul 15/.test(page.text) && /9:00 AM C[SD]T/.test(page.text) && page.text.includes('>Unschedule<') && page.text.includes('>Publish now<'));
    check('the schedule form is a datetime-local field labelled Central Time, prefilled in Central Time', page.text.includes('type="datetime-local"') && page.text.includes(`value="${summer}"`) && page.text.includes('Central Time'));

    const before = draftRow(S);
    r = await schedule(c1, S, chicago(Date.now() - 3600_000));
    check('a time in the past is refused (schedule_past) and nothing changes', errOf(r) === 'schedule_past' && draftRow(S).publish_at === before.publish_at && draftRow(S).updated_at === before.updated_at, `${errOf(r)}`);
    r = await schedule(c1, S, 'next tuesday');
    check('an unreadable time is refused (schedule_bad)', errOf(r) === 'schedule_bad');
    r = await schedule(c1, S, `${nextYear + 3}-01-15T09:00`);
    check('a time more than a year away is refused (schedule_far)', errOf(r) === 'schedule_far');
    r = await schedule(c1, S, `${nextYear}-03-14T02:30`);
    check('a Central Time that does not exist (spring-forward gap) is refused with its own message', errOf(r) === 'schedule_gap', String(errOf(r)));
    r = await schedule(c1, S, winter, version(S) - 1);
    check('a stale version is refused (conflict) and the schedule is unchanged', errOf(r) === 'conflict' && draftRow(S).publish_at === before.publish_at);
    r = await c1.form(`/api/admin/drafts/${S}/schedule`, { publish_at: winter });
    check('a schedule post without a version is refused', errOf(r) === 'stale_page');
    r = await anon.form(`/api/admin/drafts/${S}/schedule`, { version: version(S), publish_at: winter });
    check('scheduling without a session is refused (401) and changes nothing', r.status === 401 && draftRow(S).publish_at !== null, `${r.status} ${r.loc}`);
    r = await c1.form(`/api/admin/drafts/${S}/schedule`, { version: version(S), publish_at: winter }, { Origin: 'http://evil.example' });
    check('a cross-origin schedule post is 403', r.status === 403);

    // the inbox
    const other = await mkDraft('Schedule Bravo Unscheduled Item');
    let inbox = await c1.get('/admin?status=scheduled');
    check('the inbox has a "Scheduled" status filter', (await c1.get('/admin')).text.includes('<option value="scheduled"'));
    check('the Scheduled filter lists the scheduled draft with its time and not the unscheduled one', inbox.text.includes('Schedule Alpha Retreat Report') && inbox.text.includes('Jul 15, 2027') && !inbox.text.includes('Schedule Bravo Unscheduled Item'));
    inbox = await c1.get('/admin');
    check('the default inbox shows the schedule badge on the scheduled draft', /Scheduled for\s*<time[^>]*>[^<]*Jul 15, 2027/.test(inbox.text));

    // editing keeps the schedule
    const edit = await c1.form(`/api/admin/drafts/${S}/save`, { version: version(S), ...baseFields({ title: 'Schedule Alpha Retreat Report Edited' }) });
    check('an editor save after scheduling keeps the schedule', edit.status === 200 && draftRow(S).publish_at === Date.parse(`${nextYear}-07-15T14:00:00Z`));
    const revs = q('SELECT payload FROM draft_revisions WHERE draft_id = ?', S);
    check('revisions never carry the schedule (publish_at is not editorial state)', revs.length > 0 && !revs.some((x) => /publish_?at|suggested/i.test(x.payload)));

    r = await c2.form(`/api/admin/drafts/${S}/unschedule`, { version: version(S) });
    check('another editor can unschedule; it is audited (draft.unschedule) and clears the schedule', noteOf(r) === 'unscheduled' && draftRow(S).publish_at === null && draftRow(S).publish_at_by === null && auditRows('draft.unschedule', `draft:${S}`).length === 1);
    const v0 = version(S);
    r = await c2.form(`/api/admin/drafts/${S}/unschedule`, { version: v0 });
    check('unscheduling a draft that is not scheduled changes nothing (no version bump, no audit entry)', version(S) === v0 && auditRows('draft.unschedule', `draft:${S}`).length === 1);
    check('the Scheduled filter no longer lists it', !(await c1.get('/admin?status=scheduled')).text.includes('Schedule Alpha Retreat Report'));
  }

  // ================= reject and publish-now clear the schedule =================
  {
    const R = await mkDraft('Schedule Reject Candidate');
    await schedule(c1, R, `${nextYear}-02-10T10:00`);
    check('(setup) the reject candidate is scheduled', draftRow(R).publish_at !== null);
    let r = await c1.form(`/api/admin/drafts/${R}/reject`, { version: version(R), note: '' });
    check('rejecting a scheduled draft clears the schedule', draftRow(R).status === 'rejected' && draftRow(R).publish_at === null && draftRow(R).publish_at_by === null);
    r = await schedule(c1, R, `${nextYear}-02-10T10:00`);
    check('a rejected (closed) draft cannot be scheduled', errOf(r) === 'closed' && draftRow(R).publish_at === null, String(errOf(r)));

    const P = await mkDraft('Schedule Publish Now Item');
    await schedule(c1, P, `${nextYear}-02-11T10:00`);
    r = await c1.form(`/api/admin/drafts/${P}/publish`, { version: version(P) });
    check('Publish now on a scheduled draft publishes it and clears the schedule', noteOf(r) === 'published' && draftRow(P).status === 'published' && draftRow(P).publish_at === null && draftRow(P).publish_at_by === null, `${r.loc}`);
    const a = auditRows('draft.publish', `draft:${P}`);
    check('...with the ordinary draft.publish audit entry (not marked scheduled)', a.length === 1 && !(a[0].detail || '').includes('scheduled'));
  }

  // ================= due drafts publish exactly once, two servers racing =================
  {
    startServer(PORT_B);
    await ready(BASE_B);
    const ids = [];
    for (const t of ['Race One Harvest Festival', 'Race Two Youth Rally', 'Race Three Health Expo', 'Race Four Music Night']) ids.push(await mkDraft(t));
    const soon = Date.now() + 3500;
    for (const id of ids) {
      const r = await schedule(c1, id, chicago(soon + 60_000)); // the form has minute resolution; move it to the near future below
      if (noteOf(r) !== 'scheduled') throw new Error('setup: could not schedule ' + id);
    }
    // The form only takes whole minutes, so bring the due time forward in the database: this is the only direct write (the schedule itself came from the route).
    run(`UPDATE drafts SET publish_at = ? WHERE id IN (${ids.join(',')})`, soon);
    // A draft edited after scheduling (by the second editor) must publish its LATEST content.
    const edited = ids[0];
    const sv = await c2.form(`/api/admin/drafts/${edited}/save`, { version: version(edited), ...baseFields({ title: 'Race One Harvest Festival Latest Edit', body: 'The newest text written after scheduling.' }) });
    check('(setup) an edit after scheduling succeeds', sv.status === 200 && draftRow(edited).publish_at === soon);
    check('nothing publishes before its time', ids.every((id) => draftRow(id).status !== 'published'));
    const done = await until(() => ids.every((id) => draftRow(id).status === 'published'), 20000);
    check('every due draft is published by the scheduler without anyone clicking Publish', done, ids.map((id) => draftRow(id).status).join());
    await sleep(1500); // give the second server's ticks time to (wrongly) publish again
    for (const id of ids) {
      const pubs = auditRows('draft.publish', `draft:${id}`);
      const st = q('SELECT COUNT(*) n FROM stories WHERE slug = ?', draftRow(id).slug)[0].n;
      check(`draft ${id}: exactly one publish audit entry (scheduled, by the person who scheduled it) and one story row`, pubs.length === 1 && JSON.parse(pubs[0].detail).scheduled === true && pubs[0].user_id === E1.id && st === 1, `${pubs.length} ${st}`);
      check(`draft ${id}: the schedule and claim are cleared after publishing`, draftRow(id).publish_at === null && draftRow(id).publish_claimed_at === null && draftRow(id).publish_fail_count === 0);
    }
    check('the draft edited after scheduling went live with its latest edit', (await anon.get(`/stories/${draftRow(edited).slug}/`)).text.includes('Race One Harvest Festival Latest Edit') && q('SELECT body FROM stories WHERE slug = ?', draftRow(edited).slug)[0].body.includes('newest text written after scheduling'));
    check('both servers serve the published story', (await anon.get(`/stories/${draftRow(ids[1]).slug}/`)).status === 200 && (await new Client(null, BASE_B).get(`/stories/${draftRow(ids[1]).slug}/`)).status === 200);
    check('a published scheduled draft no longer appears under Scheduled', !(await c1.get('/admin?status=scheduled')).text.includes('Race Two Youth Rally'));
    check('the page for a draft the scheduler published says it is live', (await c1.get(`/admin/drafts/${ids[1]}`)).text.includes('This story is live'));

    // a fresh claim by another process blocks a due draft; a stale claim does not
    const C = await mkDraft('Claim Probe Scouts Weekend');
    await schedule(c1, C, `${nextYear}-03-01T10:00`);
    run('UPDATE drafts SET publish_at = ?, publish_claimed_at = ? WHERE id = ?', Date.now() - 1000, Date.now(), C);
    await sleep(1500);
    check('a due draft that another process has just claimed is left alone', draftRow(C).status !== 'published' && auditRows('draft.publish', `draft:${C}`).length === 0);
    run('UPDATE drafts SET publish_claimed_at = ? WHERE id = ?', Date.now() - 10 * 60_000, C);
    check('...but an abandoned (stale) claim is taken over and published once', await until(() => draftRow(C).status === 'published', 10000) && auditRows('draft.publish', `draft:${C}`).length === 1);
  }

  // ================= failure path =================
  {
    const F = await mkDraft('Failure Probe Placeholder');
    // An empty title cannot be published ("title_required"); saving is lenient, publishing is not.
    const sv = await c1.form(`/api/admin/drafts/${F}/save`, { version: version(F), ...baseFields({ title: '' }) });
    check('(setup) a draft with no title can be saved', sv.status === 200);
    await schedule(c1, F, `${nextYear}-03-02T10:00`);
    run('UPDATE drafts SET publish_at = ? WHERE id = ?', Date.now() + 1500, F);
    check('a scheduled publish that cannot succeed is marked failed with its error code', await until(() => draftRow(F).publish_fail_count >= 1, 15000) && draftRow(F).publish_error === 'title_required', JSON.stringify([draftRow(F).publish_fail_count, draftRow(F).publish_error]));
    check('it retries and then stops after 3 failures', await until(() => draftRow(F).publish_fail_count === 3, 15000));
    await sleep(2000);
    const row = draftRow(F);
    check('...and makes no fourth attempt; the draft is still scheduled and unpublished', row.publish_fail_count === 3 && row.status !== 'published' && row.publish_at !== null && row.publish_claimed_at === null, JSON.stringify(row));
    check('each failed attempt is audited (draft.schedule_failed) with the code only', auditRows('draft.schedule_failed', `draft:${F}`).length === 3 && auditRows('draft.schedule_failed', `draft:${F}`).every((a) => JSON.parse(a.detail).code === 'title_required' && Object.keys(JSON.parse(a.detail)).length === 1));
    const page = await c1.get(`/admin/drafts/${F}`);
    check('the draft page says "Scheduled publish failed", names the problem and that it stopped', page.text.includes('Scheduled publish failed') && page.text.includes('Add a title before publishing') && page.text.includes('stopped'));
    check('the inbox shows the failed badge', (await c1.get('/admin?status=scheduled')).text.includes('Scheduled publish failed'));
    // an editor fixes it and reschedules: the failure state is reset and it publishes
    const fix = await c1.form(`/api/admin/drafts/${F}/save`, { version: version(F), ...baseFields({ title: 'Failure Probe Fixed Title' }) });
    check('(fix) saving a title keeps the failed schedule as it was', fix.status === 200 && draftRow(F).publish_fail_count === 3);
    await schedule(c1, F, `${nextYear}-03-03T10:00`);
    check('rescheduling resets the failure count and error', draftRow(F).publish_fail_count === 0 && draftRow(F).publish_error === null);
    run('UPDATE drafts SET publish_at = ? WHERE id = ?', Date.now() + 500, F);
    check('...and the fixed draft then publishes', await until(() => draftRow(F).status === 'published', 15000) && auditRows('draft.publish', `draft:${F}`).length === 1);
  }

  // ================= the AI agent: suggestion only =================
  {
    const future = isoIn(2 * 24 * 3600_000, '-06:00');
    const futureMs = Date.parse(future);
    let r = await agent('POST', '/api/agent/stories', story({ sourceUrl: 'https://example.test/posts/sched-1', suggestedPublishAt: future }));
    check('the agent can create a draft with a suggestedPublishAt', r.status < 300 && r.data.ok, `${r.status} ${r.text.slice(0, 160)}`);
    const A = r.data.id;
    check('...stored as milliseconds in suggested_publish_at, and not as a schedule', draftRow(A).suggested_publish_at === futureMs && draftRow(A).publish_at === null && draftRow(A).status === 'new');
    r = await agent('GET', `/api/agent/stories/${A}`);
    check('read-back returns it as an ISO 8601 UTC string', r.status === 200 && r.data.draft?.suggestedPublishAt === new Date(futureMs).toISOString() || r.data.suggestedPublishAt === new Date(futureMs).toISOString(), r.text.slice(0, 200));
    r = await agent('POST', '/api/agent/stories', story({ sourceUrl: 'https://example.test/posts/sched-1', title: 'Synthetic Pathfinder Campout Report Retitled' }));
    check('an update that omits it keeps the stored suggestion', r.status < 300 && draftRow(A).suggested_publish_at === futureMs && draftRow(A).title.endsWith('Retitled'), `${r.status}`);
    const later = isoIn(3 * 24 * 3600_000, 'Z');
    r = await agent('POST', '/api/agent/stories', story({ sourceUrl: 'https://example.test/posts/sched-1', suggestedPublishAt: later }));
    check('an update can change it', r.status < 300 && draftRow(A).suggested_publish_at === Date.parse(later));
    r = await agent('POST', '/api/agent/stories', story({ sourceUrl: 'https://example.test/posts/sched-1', suggestedPublishAt: null }));
    check('null clears it', r.status < 300 && draftRow(A).suggested_publish_at === null);

    for (const [label, value] of [['no offset', '2030-11-02T08:00:00'], ['a date only', '2030-11-02'], ['words', 'tomorrow morning'], ['a number', 1893456000000], ['an impossible day', `${nextYear}-02-30T08:00:00-06:00`], ['the past', '2020-01-01T08:00:00-06:00'], ['more than a year away', `${nextYear + 4}-01-01T08:00:00-06:00`], ['an empty string', '']]) {
      r = await agent('POST', '/api/agent/stories', story({ sourceUrl: 'https://example.test/posts/sched-bad', suggestedPublishAt: value }));
      check(`invalid suggestedPublishAt (${label}) is 400 bad_publish_at`, r.status === 400 && r.data.error === 'bad_publish_at', `${r.status} ${r.text.slice(0, 120)}`);
    }
    check('...and none of those created a draft', q("SELECT COUNT(*) n FROM drafts WHERE source_url = 'https://example.test/posts/sched-bad'")[0].n === 0);

    r = await agent('POST', '/api/agent/stories/batch', { requestId: 'sched-batch-0001', stories: [story({ sourceUrl: 'https://example.test/posts/sched-b1', suggestedPublishAt: future }), story({ sourceUrl: 'https://example.test/posts/sched-b2', suggestedPublishAt: '2020-01-01T00:00:00Z' }), story({ sourceUrl: 'https://example.test/posts/sched-b3' })] });
    const items = r.data.results || [];
    check('a batch item carries suggestedPublishAt; a bad one fails alone with bad_publish_at', r.status < 300 && items[0]?.ok && items[1]?.ok === false && items[1]?.error === 'bad_publish_at' && items[2]?.ok, r.text.slice(0, 300));
    check('...the good item stored it, the item without it stored none', q("SELECT suggested_publish_at s FROM drafts WHERE source_url = 'https://example.test/posts/sched-b1'")[0].s === futureMs && q("SELECT suggested_publish_at s FROM drafts WHERE source_url = 'https://example.test/posts/sched-b3'")[0].s === null);

    r = await agent('GET', '/api/agent/sections');
    check('GET /api/agent/sections documents suggestedPublishAt (also for reopen changes)', r.status === 200 && r.data.suggestedPublishAt?.field === 'suggestedPublishAt' && r.data.reopen?.changesFields?.includes('suggestedPublishAt'));

    // reopen
    const R = await mkDraft('Reopen Suggestion Subject');
    await c1.form(`/api/admin/drafts/${R}/publish`, { version: version(R) });
    const slug = draftRow(R).slug;
    r = await agent('POST', '/api/agent/stories/reopen', { slug, requestId: 'sched-reopen-0000', changes: { suggestedPublishAt: '2020-01-01T00:00:00Z' } });
    check('reopen with a past suggestion is 400 bad_publish_at', r.status === 400 && r.data.error === 'bad_publish_at', `${r.status} ${r.text.slice(0, 120)}`);
    r = await agent('POST', '/api/agent/stories/reopen', { slug, requestId: 'sched-reopen-0001', changes: { suggestedPublishAt: future } });
    check('reopen changes can set suggestedPublishAt on the review draft', r.status < 300 && r.data.ok !== false && draftRow(R).suggested_publish_at === futureMs && draftRow(R).status === 'in_review', `${r.status} ${r.text.slice(0, 200)}`);
    check('...and the reopened draft is NOT scheduled; the live story is untouched', draftRow(R).publish_at === null && q('SELECT status FROM stories WHERE slug = ?', slug)[0].status === 'live');

    // the agent never publishes: wait several scheduler ticks
    await sleep(1500);
    check('the agent suggestion never schedules or publishes anything (several scheduler ticks later)', q("SELECT COUNT(*) n FROM drafts WHERE source = 'agent' AND (publish_at IS NOT NULL OR (status = 'published' AND id <> ?))", R)[0].n === 0 && draftRow(A).status === 'new');
    const wrongRoute = await new Client(null).form(`/api/admin/drafts/${A}/schedule`, { version: version(A), use_suggestion: 1 }, { Authorization: `Bearer ${AGENT_TOKEN}` });
    check('the agent token cannot schedule through the dashboard route', wrongRoute.status !== 200 && draftRow(A).publish_at === null, `${wrongRoute.status} ${wrongRoute.loc}`);

    // one-click schedule from the suggestion
    r = await agent('POST', '/api/agent/stories', story({ sourceUrl: 'https://example.test/posts/sched-click', suggestedPublishAt: future }));
    const K = r.data.id;
    const page = await c1.get(`/admin/drafts/${K}`);
    check('the editor shows "AI agent suggests publishing at ..." in Central Time with a "Schedule for this time" button', page.text.includes('AI agent suggests publishing at') && page.text.includes('>Schedule for this time<') && /C[SD]T/.test(page.text));
    check('a person has not scheduled anything yet', draftRow(K).publish_at === null);
    r = await c1.form(`/api/admin/drafts/${K}/schedule`, { version: version(K) - 1, use_suggestion: 1 });
    check('one-click scheduling is version-checked too', errOf(r) === 'conflict' && draftRow(K).publish_at === null);
    r = await c1.form(`/api/admin/drafts/${K}/schedule`, { version: version(K), use_suggestion: 1 });
    check('one-click "Schedule for this time" schedules exactly the suggested instant, as the signed-in editor', noteOf(r) === 'scheduled' && draftRow(K).publish_at === futureMs && draftRow(K).publish_at_by === E1.id, `${r.loc}`);
    check('...and the audit entry records it came from the suggestion', JSON.parse(auditRows('draft.schedule', `draft:${K}`)[0].detail).from === 'suggestion');
    const noSuggestion = await mkDraft('No Suggestion Here');
    r = await c1.form(`/api/admin/drafts/${noSuggestion}/schedule`, { version: version(noSuggestion), use_suggestion: 1 });
    check('"use the suggestion" on a draft with none is refused (schedule_none)', errOf(r) === 'schedule_none' && draftRow(noSuggestion).publish_at === null);
    run('UPDATE drafts SET suggested_publish_at = ? WHERE id = ?', Date.now() - 5000, noSuggestion);
    r = await c1.form(`/api/admin/drafts/${noSuggestion}/schedule`, { version: version(noSuggestion), use_suggestion: 1 });
    check('a suggestion whose time has passed is refused like any past time', errOf(r) === 'schedule_past' && draftRow(noSuggestion).publish_at === null, String(errOf(r)));
  }

  // ================= review fixes: Studio, unpublish, inactive owner, replay, stale suggestion =================
  {
    // --- Studio publishes over a scheduled open draft: the schedule is cleared, never run later ---
    const SR = await mkDraft('Studio Overlap Subject');
    await c1.form(`/api/admin/drafts/${SR}/publish`, { version: version(SR) });
    const slugS = draftRow(SR).slug;
    let r = await agent('POST', '/api/agent/stories/reopen', { slug: slugS, requestId: 'sched-studio-reopen-01', changes: { dek: 'An edit waiting for review.' } });
    check('(setup) a live story has an open reopened draft', r.status < 300 && draftRow(SR).status === 'in_review', r.text.slice(0, 160));
    await schedule(c1, SR, `${nextYear}-04-01T10:00`);
    check('(setup) that open draft is scheduled', draftRow(SR).publish_at !== null);
    const sp = await fetch(BASE + '/api/publish', { method: 'POST', headers: { Authorization: `Bearer ${baseEnv.PUBLISH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ newsletter: { name: 'Sched Issue', issueDate: draftRow(SR).date }, stories: [{ ref: 'sr', title: 'Studio Overlap Subject', section: 'news', area: 'churches', author: 'Studio Author', body: 'Studio rewrote this body and it is live.', photos: [] }] }) });
    const spText = await sp.text();
    check('Studio /api/publish over the same address succeeds', sp.status === 200 && spText.includes(slugS), spText.slice(0, 200));
    check('Studio publishing cleared every schedule column', draftRow(SR).publish_at === null && draftRow(SR).publish_at_by === null && draftRow(SR).publish_claimed_at === null && draftRow(SR).publish_error === null && draftRow(SR).publish_fail_count === 0, JSON.stringify(draftRow(SR)));
    const au = auditRows('draft.unschedule', `draft:${SR}`);
    check('...and audited draft.unschedule with reason studio_publish', au.length === 1 && JSON.parse(au[0].detail).reason === 'studio_publish', JSON.stringify(au));
    check('the draft is flagged as overwritten by Studio', draftRow(SR).studio_overwrote_at !== null);
    r = await schedule(c1, SR, `${nextYear}-04-02T10:00`);
    check('such a draft cannot be scheduled again (schedule_studio_overwrote)', errOf(r) === 'schedule_studio_overwrote' && draftRow(SR).publish_at === null, String(errOf(r)));
    run('UPDATE drafts SET publish_at = ?, publish_at_by = ? WHERE id = ?', Date.now() - 1000, E1.id, SR);
    check('belt and braces: if a schedule somehow exists, the scheduler refuses at once with schedule_studio_overwrote', await until(() => draftRow(SR).publish_error === 'schedule_studio_overwrote', 10000) && draftRow(SR).publish_fail_count === 3);
    await sleep(1000);
    check('...and Studio\'s live body is untouched', q('SELECT body FROM stories WHERE slug = ?', slugS)[0].body.includes('Studio rewrote this body') && auditRows('draft.schedule_failed', `draft:${SR}`).length === 1);

    // --- unpublishing clears the schedule (single and bulk), so the timer never republishes ---
    for (const mode of ['single', 'bulk']) {
      const U = await mkDraft(`Unpublish ${mode} Subject`);
      await c1.form(`/api/admin/drafts/${U}/publish`, { version: version(U) });
      const slugU = draftRow(U).slug;
      r = await agent('POST', '/api/agent/stories/reopen', { slug: slugU, requestId: `sched-unpub-${mode}-01`, changes: { dek: 'Waiting.' } });
      await schedule(c1, U, `${nextYear}-04-03T10:00`);
      check(`(${mode}) the live story's open draft is scheduled`, draftRow(U).publish_at !== null, r.text.slice(0, 160));
      const ur = mode === 'single' ? await c1.form('/api/admin/stories/unpublish', { slug: slugU }) : await cAdm.form('/admin/bulk', { action: 'unpublish', step: 'run', slug: slugU });
      check(`(${mode}) the story is unpublished`, q('SELECT status FROM stories WHERE slug = ?', slugU)[0].status !== 'live', `${ur.status}`);
      const ua = auditRows('draft.unschedule', `draft:${U}`);
      check(`(${mode}) the schedule columns are cleared and audited with reason unpublished`, draftRow(U).publish_at === null && draftRow(U).publish_at_by === null && ua.length === 1 && JSON.parse(ua[0].detail).reason === 'unpublished', JSON.stringify(ua));
      run('UPDATE drafts SET publish_at = ? WHERE id = ?', null, U);
      await sleep(1200);
      check(`(${mode}) nothing republishes it afterwards`, q('SELECT status FROM stories WHERE slug = ?', slugU)[0].status !== 'live' && draftRow(U).status === 'in_review');
    }

    // --- the person who scheduled is no longer an active user ---
    const O = await mkDraft('Owner Left Subject');
    await schedule(c3, O, `${nextYear}-04-04T10:00`);
    check('(setup) a second editor scheduled it', draftRow(O).publish_at_by === E3.id);
    run("UPDATE users SET status = 'disabled' WHERE id = ?", E3.id);
    run('UPDATE drafts SET publish_at = ? WHERE id = ?', Date.now() + 1200, O);
    check('a schedule whose owner is no longer active is not run: it fails at once with schedule_owner_inactive', await until(() => draftRow(O).publish_error === 'schedule_owner_inactive', 15000) && draftRow(O).publish_fail_count === 3);
    await sleep(1500);
    check('...with a single audited attempt, no retries, and the draft is unpublished', auditRows('draft.schedule_failed', `draft:${O}`).length === 1 && draftRow(O).status !== 'published' && draftRow(O).publish_at !== null);
    const op = await c1.get(`/admin/drafts/${O}`);
    check('the draft page shows the plain message and that it was not retried', op.text.includes('Scheduled publish failed') && op.text.includes('can no longer sign in; schedule it again') && op.text.includes('not retried'));
    await schedule(c1, O, `${nextYear}-04-05T10:00`);
    run('UPDATE drafts SET publish_at = ? WHERE id = ?', Date.now() + 500, O);
    check('rescheduling by an active editor then publishes it', await until(() => draftRow(O).status === 'published', 15000));

    // --- an identical agent retry still acknowledges after the suggested time has passed ---
    const soon = new Date(Date.now() + 2500).toISOString();
    const body = story({ sourceUrl: 'https://example.test/posts/sched-replay', suggestedPublishAt: soon, requestId: 'sched-replay-0001' });
    r = await agent('POST', '/api/agent/stories', body);
    check('(setup) create with a requestId and a suggestion 2.5 seconds away', r.status < 300 && r.data.ok, r.text.slice(0, 160));
    const rid = r.data.id;
    await sleep(3200);
    r = await agent('POST', '/api/agent/stories', body);
    check('an identical retry after the time has passed is acknowledged as replayed (not 400)', r.status === 200 && r.data.status === 'replayed' && r.data.id === rid, `${r.status} ${r.text.slice(0, 160)}`);
    r = await agent('POST', '/api/agent/stories', story({ sourceUrl: 'https://example.test/posts/sched-replay-new', suggestedPublishAt: soon }));
    check('...but a NEW request with a past time is still 400 bad_publish_at', r.status === 400 && r.data.error === 'bad_publish_at');
    const soonB = new Date(Date.now() + 2500).toISOString();
    const batch = { requestId: 'sched-replay-batch-1', stories: [story({ sourceUrl: 'https://example.test/posts/sched-replay-b1', suggestedPublishAt: soonB })] };
    r = await agent('POST', '/api/agent/stories/batch', batch);
    check('(setup) a batch with a near suggestion is accepted', r.status < 300 && r.data.results?.[0]?.ok, r.text.slice(0, 200));
    await sleep(3200);
    r = await agent('POST', '/api/agent/stories/batch', batch);
    check('an identical batch retry after the time has passed is acknowledged', r.status < 300 && r.data.results?.[0]?.ok && r.data.results[0].status === 'created' || r.data.results?.[0]?.status === 'replayed', `${r.status} ${r.text.slice(0, 200)}`);
    const soonI = new Date(Date.now() + 2500).toISOString();
    const itemBody = story({ sourceUrl: 'https://example.test/posts/sched-replay-item', suggestedPublishAt: soonI, requestId: 'sched-replay-item-1' });
    r = await agent('POST', '/api/agent/stories/batch', { requestId: 'sched-replay-batch-2', stories: [itemBody] });
    await sleep(3200);
    r = await agent('POST', '/api/agent/stories/batch', { requestId: 'sched-replay-batch-3', stories: [itemBody] });
    check('a batch item that repeats an accepted item (own requestId) replays after the time has passed', r.status < 300 && r.data.results?.[0]?.ok && r.data.results[0].status === 'replayed', `${r.status} ${r.text.slice(0, 200)}`);
    const RO = await mkDraft('Reopen Replay Subject');
    await c1.form(`/api/admin/drafts/${RO}/publish`, { version: version(RO) });
    const soonR = new Date(Date.now() + 2500).toISOString();
    const reopen = { slug: draftRow(RO).slug, requestId: 'sched-replay-reopen-1', changes: { suggestedPublishAt: soonR } };
    r = await agent('POST', '/api/agent/stories/reopen', reopen);
    check('(setup) reopen with a near suggestion is accepted', r.status < 300 && draftRow(RO).suggested_publish_at === Date.parse(soonR), r.text.slice(0, 160));
    await sleep(3200);
    r = await agent('POST', '/api/agent/stories/reopen', reopen);
    check('an identical reopen retry after the time has passed is acknowledged as replayed', r.status < 300 && r.data.status === 'replayed', `${r.status} ${r.text.slice(0, 160)}`);

    // --- publishing clears the suggestion ---
    const SG = await agent('POST', '/api/agent/stories', story({ sourceUrl: 'https://example.test/posts/sched-clear', suggestedPublishAt: isoIn(2 * 24 * 3600_000, 'Z') }));
    check('(setup) an agent draft with a suggestion', draftRow(SG.data.id).suggested_publish_at !== null);
    await c1.form(`/api/admin/drafts/${SG.data.id}/publish`, { version: version(SG.data.id) });
    check('publishing clears suggested_publish_at', draftRow(SG.data.id).status === 'published' && draftRow(SG.data.id).suggested_publish_at === null);
  }
} catch (err) {
  console.error('TEST SCRIPT ERROR', err);
  fails++;
} finally {
  stop();
}
if (fails) { console.log(`\n${fails} check(s) failed`); console.log(serverLog.join('').split('\n').slice(-25).join('\n')); process.exit(1); }
console.log('\nAll scheduled publishing checks passed.');
