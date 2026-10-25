#!/usr/bin/env node
// A tiny local OpenID Connect provider for scripts/test-editor-oauth.mjs. It stands in for BOTH Google and Microsoft:
//   GET  /<google|microsoft>/authorize   -> 302 back to redirect_uri with ?code&state (the test plays the browser)
//   POST /<google|microsoft>/token       -> checks PKCE (S256), the client id and secret, returns an unsigned id_token
//   POST /__identity  {email, email_verified, sub, tid, oid, preferred_username, omit:[...], nonce?: "wrong", aud?: ...}
//                     sets who the NEXT authorization signs in as (one use)
//   GET  /__log       -> what the mock saw (never anything but made-up values)
// Run: MOCK_OIDC_PORT=4417 node scripts/mock-oidc.mjs. Synthetic values only; never point this at a real site's secrets.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_OIDC_PORT || 4417);
const BASE = `http://localhost:${PORT}`;
// Made-up ids and secrets with characters that must survive form-urlencoding (+, space, %, :), so an encoding regression is caught.
const CLIENTS = {
  google: { id: 'mock google+client:id%1', secret: 'mock+google secret:%s/x' },
  microsoft: { id: 'mock ms+client:id%2', secret: 'mock+ms secret:%s/y' },
};
// application/x-www-form-urlencoded, exactly as RFC 6749 2.3.1 requires before the Basic header's base64.
const formEncode = (v) => new URLSearchParams({ v }).toString().slice(2);
const formDecode = (v) => new URLSearchParams(`v=${v}`).get('v');

const codes = new Map(); // code -> { provider, challenge, nonce, identity, redirect_uri }
let nextIdentity = null;
const log = [];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const m = /^\/(google|microsoft)\/(authorize|token)$/.exec(url.pathname);
  try {
    if (url.pathname === '/__identity' && req.method === 'POST') {
      nextIdentity = JSON.parse(await readBody(req));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__log') return send(res, 200, log);
    if (!m) return send(res, 404, { error: 'not_found' });
    const provider = m[1];
    if (m[2] === 'authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== CLIENTS[provider].id || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state') || !q.get('nonce') || q.get('response_type') !== 'code') {
        return send(res, 400, { error: 'invalid_request' });
      }
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { provider, challenge: q.get('code_challenge'), nonce: q.get('nonce'), identity: nextIdentity || {}, redirect_uri: q.get('redirect_uri'), scope: q.get('scope') });
      nextIdentity = null;
      log.push({ event: 'authorize', provider, scope: q.get('scope'), state_len: q.get('state').length });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      return send(res, 302, '', { Location: back.toString() });
    }
    // token endpoint
    const form = new URLSearchParams(await readBody(req));
    let id = form.get('client_id');
    let secret = form.get('client_secret');
    const basic = /^Basic (.+)$/.exec(req.headers.authorization || '');
    if (basic) {
      // Strict RFC 6749 2.3.1: base64( formEncode(id) + ':' + formEncode(secret) ). The raw parts must be EXACTLY the form encoding of the
      // decoded values, so a client that sends encodeURIComponent output or no encoding is refused when a value has special characters.
      const parts = Buffer.from(basic[1], 'base64').toString().split(':');
      const strict = parts.length === 2 && parts.every((x) => formEncode(formDecode(x)) === x);
      [id, secret] = strict ? parts.map(formDecode) : [null, null];
    }
    const entry = codes.get(form.get('code') || '');
    codes.delete(form.get('code') || ''); // single use
    if (!entry || entry.provider !== provider || id !== CLIENTS[provider].id || secret !== CLIENTS[provider].secret) {
      log.push({ event: 'token_refused', provider });
      return send(res, 400, { error: 'invalid_grant' });
    }
    const verifier = form.get('code_verifier') || '';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (challenge !== entry.challenge || form.get('redirect_uri') !== entry.redirect_uri) {
      log.push({ event: 'token_refused_pkce', provider });
      return send(res, 400, { error: 'invalid_grant' });
    }
    const i = entry.identity;
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: i.iss || `${BASE}/${provider}`,
      aud: i.aud || CLIENTS[provider].id,
      exp: i.exp || now + 600,
      iat: now,
      nonce: i.nonce === 'wrong' ? 'not-the-nonce' : entry.nonce,
      sub: i.sub || 'mock-sub-1',
      email: i.email,
      email_verified: i.email_verified,
      preferred_username: i.preferred_username,
      tid: i.tid,
      oid: i.oid,
      name: 'Mock Person',
    };
    for (const k of i.omit || []) delete claims[k];
    log.push({ event: 'token_ok', provider, mode: i.token_mode || 'normal' });
    const idToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
    const ok = { token_type: 'Bearer', access_token: 'mock-access', expires_in: 3600, id_token: idToken };
    // Misbehaving token endpoints, for the "fail closed" tests: a redirect, an oversized body, a response that never finishes in time.
    if (i.token_mode === 'redirect') return send(res, 302, '', { Location: `${BASE}/__log` });
    if (i.token_mode === 'big') return send(res, 200, { ...ok, padding: 'x'.repeat(200_000) });
    if (i.token_mode === 'big_chunked') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); // no Content-Length: the client must count bytes
      res.write('{"padding":"');
      for (let n = 0; n < 40; n++) res.write('x'.repeat(5_000));
      return res.end(`","id_token":${JSON.stringify(idToken)}}`);
    }
    if (i.token_mode === 'slow') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"token_type":"Bearer",');
      return void setTimeout(() => { try { res.end(`"id_token":${JSON.stringify(idToken)}}`); } catch { /* client gone */ } }, 13_000);
    }
    return send(res, 200, ok);
  } catch (err) {
    send(res, 500, { error: String(err.message || err) });
  }
}).listen(PORT, () => console.log(`mock OIDC listening on ${BASE}`));
