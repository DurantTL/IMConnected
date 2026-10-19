// Local stand-in for Resend's POST /emails, for testing the confirmation email without sending any.
// Usage: node scripts/mock-email.mjs   (then set EMAIL_API_URL=http://localhost:4011/emails)
// Prints each message as one JSON line. GET /fail-on makes it answer 500; GET /fail-off restores it.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_EMAIL_PORT || 4011);
let failing = false;

createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  if (req.url === '/fail-on' || req.url === '/fail-off') {
    failing = req.url === '/fail-on';
    return res.end('ok');
  }
  if (!req.headers.authorization?.startsWith('Bearer ')) { res.writeHead(401); return res.end('{"message":"missing key"}'); }
  if (failing) { res.writeHead(500); return res.end('{"message":"mock failure"}'); }
  console.log(raw);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"id":"mock"}');
}).listen(PORT, () => console.log(`mock email API on http://localhost:${PORT}/emails`));
