// Local stand-in for the GitHub API, for testing the submit form without a real repo.
// Usage: node scripts/mock-github.mjs   (then set GITHUB_API_URL=http://localhost:4010)
// Writes each "pull request" into ./.mock-prs/<branch>/ so you can inspect the files.
// Direct commits to the base branch (/api/publish and the /admin editor) go to ./.mock-prs/direct/<commit>/,
// and GET /contents/<path> returns the newest committed version of a file (404 if never committed).
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.MOCK_PORT || 4010);
const OUT = process.env.MOCK_OUT || '.mock-prs';
const blobs = new Map();
const trees = new Map();
const commits = new Map();
const prs = new Map(); // PR number -> { head, labels:Set }
const directFiles = new Map(); // path -> Buffer, files committed straight to the base branch (newest wins)
let tip = 'base';
let failStatus = 0; // POST /__mock/fail {"status":422} makes every final ref update answer with that status until set to 0
let delayMs = 0; // POST /__mock/delay {"ms":1500} slows the final ref update, to test edits made while a publish is in flight
let n = 0;
const id = () => (++n).toString(16).padStart(40, '0');

createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const p = req.url.replace(/^\/repos\/[^/]+\/[^/]+/, '').split('?')[0];
  console.log(req.method, p);

  if (!req.headers.authorization?.startsWith('Bearer ')) return send(401, { message: 'Bad credentials' });
  if (req.method === 'POST' && p === '/__mock/fail') { failStatus = Number(body.status) || 0; return send(200, { ok: true }); }
  if (req.method === 'POST' && p === '/__mock/delay') { delayMs = Number(body.ms) || 0; return send(200, { ok: true }); }
  if (req.method === 'GET' && p.startsWith('/git/ref/heads/')) return send(200, { object: { sha: tip } });
  if (req.method === 'GET' && p.startsWith('/git/commits/')) return send(200, { tree: { sha: commits.get(p.split('/').pop())?.tree ?? 'basetree' } });
  if (req.method === 'GET' && p.startsWith('/contents/')) {
    const file = directFiles.get(decodeURIComponent(p.slice('/contents/'.length)));
    return file
      ? send(200, { type: 'file', encoding: 'base64', content: file.toString('base64'), sha: `blob${file.length}` })
      : send(404, { message: 'Not Found' });
  }
  if (req.method === 'PATCH' && p.startsWith('/git/refs/heads/')) {
    // Direct commit to the base branch (the publish API). Mirrors GitHub: non-fast-forward is refused.
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (failStatus) return send(failStatus, { message: 'Mock failure' });
    const commit = commits.get(body.sha);
    if (!commit || commit.parents?.[0] !== tip) return send(422, { message: 'Update is not a fast forward' });
    const dir = join(OUT, 'direct', body.sha);
    for (const entry of trees.get(commit.tree)) {
      const b = blobs.get(entry.sha);
      const file = join(dir, entry.path);
      mkdirSync(dirname(file), { recursive: true });
      const bytes = Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8');
      writeFileSync(file, bytes);
      directFiles.set(entry.path, bytes);
    }
    writeFileSync(join(dir, 'COMMIT_MESSAGE.txt'), commit.message);
    tip = body.sha;
    return send(200, { ref: p.slice('/git/'.length), object: { sha: tip } });
  }
  if (req.method === 'POST' && p === '/git/blobs') { const s = id(); blobs.set(s, body); return send(201, { sha: s }); }
  if (req.method === 'POST' && p === '/git/trees') { const s = id(); trees.set(s, body.tree); return send(201, { sha: s }); }
  if (req.method === 'POST' && p === '/git/commits') { const s = id(); commits.set(s, body); return send(201, { sha: s }); }
  if (req.method === 'POST' && p === '/git/refs') {
    const commit = commits.get(body.sha);
    const branch = body.ref.replace('refs/heads/', '');
    for (const entry of trees.get(commit.tree)) {
      const b = blobs.get(entry.sha);
      const file = join(OUT, branch, entry.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8'));
    }
    writeFileSync(join(OUT, branch, 'COMMIT_MESSAGE.txt'), commit.message);
    return send(201, { ref: body.ref });
  }
  if (req.method === 'POST' && p === '/pulls') {
    writeFileSync(join(OUT, body.head, 'PR.md'), `# ${body.title}\n\n${body.body}\n`);
    prs.set(n, { head: body.head, title: body.title, labels: new Set() });
    return send(201, { number: n, html_url: `https://github.com/mock/repo/pull/${n}` });
  }
  // Labels: add (POST), remove one (DELETE). The current labels are written to <branch>/LABELS.txt.
  const lab = /^\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(p);
  if (lab) {
    const pr = prs.get(Number(lab[1]));
    if (!pr) return send(404, { message: 'Not Found' });
    if (req.method === 'POST') for (const l of body.labels ?? []) pr.labels.add(l);
    else if (req.method === 'DELETE') { if (!pr.labels.delete(decodeURIComponent(lab[2] ?? ''))) return send(404, { message: 'Label does not exist' }); }
    else return send(404, { message: 'Not Found' });
    writeFileSync(join(OUT, pr.head, 'LABELS.txt'), [...pr.labels].join('\n') + '\n');
    return send(200, [...pr.labels].map((name) => ({ name })));
  }
  // Update a PR description (the submit endpoint records the email status this way).
  const upd = /^\/pulls\/(\d+)$/.exec(p);
  if (req.method === 'PATCH' && upd) {
    const pr = prs.get(Number(upd[1]));
    if (!pr) return send(404, { message: 'Not Found' });
    writeFileSync(join(OUT, pr.head, 'PR.md'), `# ${pr.title}\n\n${body.body}\n`);
    return send(200, { number: Number(upd[1]) });
  }
  send(404, { message: 'Not Found' });
}).listen(PORT, () => console.log(`mock GitHub API on http://localhost:${PORT}`));
