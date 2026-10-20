// Local stand-in for Resend's POST /emails, for testing the confirmation email without sending any.
// Usage: node scripts/mock-email.mjs   (then set EMAIL_API_URL=http://localhost:4011/emails)
// Prints each message as one JSON line. GET /fail-on makes it answer 500; GET /fail-off restores it.
// POST /emails/batch takes a JSON array (Resend's batch endpoint): each message is printed as a line, preceded by
// a {"batchRequest":<count>} line. GET /rate-limit-once makes the next batch answer 429 (retry-after: 1).
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_EMAIL_PORT || 4011);
let failing = false;
let limitOnce = false;

createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  if (req.url === '/rate-limit-once') { limitOnce = true; return res.end('ok'); }
  if (req.url === '/fail-on' || req.url === '/fail-off') {
    failing = req.url === '/fail-on';
    return res.end('ok');
  }
  if (!req.headers.authorization?.startsWith('Bearer ')) { res.writeHead(401); return res.end('{"message":"missing key"}'); }
  if (failing) { res.writeHead(500); return res.end('{"message":"mock failure"}'); }
  if (req.url === '/emails/batch') {
    if (limitOnce) { limitOnce = false; console.log('{"rateLimited":true}'); res.writeHead(429, { 'retry-after': '1' }); return res.end('{"message":"Too many requests"}'); }
    let list;
    try { list = JSON.parse(raw); } catch { res.writeHead(400); return res.end('{"message":"bad json"}'); }
    if (!Array.isArray(list)) { res.writeHead(400); return res.end('{"message":"expected an array"}'); }
    console.log(JSON.stringify({ batchRequest: list.length }));
    for (const m of list) console.log(JSON.stringify(m));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: list.map((_, i) => ({ id: 'mock' + i })) }));
  }
  console.log(raw);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"id":"mock"}');
}).listen(PORT, () => console.log(`mock email API on http://localhost:${PORT}/emails`));
