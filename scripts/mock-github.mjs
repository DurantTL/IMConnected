// Local stand-in for the GitHub API, for testing the submit form without a real repo.
// Usage: node scripts/mock-github.mjs   (then set GITHUB_API_URL=http://localhost:4010)
// Writes each "pull request" into ./.mock-prs/<branch>/ so you can inspect the files.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.MOCK_PORT || 4010);
const OUT = process.env.MOCK_OUT || '.mock-prs';
const blobs = new Map();
const trees = new Map();
const commits = new Map();
let n = 0;
const id = () => (++n).toString(16).padStart(40, '0');

createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const p = req.url.replace(/^\/repos\/[^/]+\/[^/]+/, '');
  console.log(req.method, p);

  if (!req.headers.authorization?.startsWith('Bearer ')) return send(401, { message: 'Bad credentials' });
  if (req.method === 'GET' && p.startsWith('/git/ref/heads/')) return send(200, { object: { sha: 'base' } });
  if (req.method === 'GET' && p.startsWith('/git/commits/')) return send(200, { tree: { sha: 'basetree' } });
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
    return send(201, { number: n, html_url: `https://github.com/mock/repo/pull/${n}` });
  }
  if (req.method === 'POST' && /\/issues\/\d+\/labels/.test(p)) return send(200, []);
  send(404, { message: 'Not Found' });
}).listen(PORT, () => console.log(`mock GitHub API on http://localhost:${PORT}`));
