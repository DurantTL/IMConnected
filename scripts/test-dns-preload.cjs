// Test-only: load with NODE_OPTIONS="--require ./scripts/test-dns-preload.cjs" so the submit form's email
// domain check finds a mail server for every domain without any network access. Never use in production.
const dns = require('node:dns');
const mx = async () => [{ exchange: 'mx.e2e-mail.com', priority: 10 }];
dns.promises.resolveMx = mx;
dns.promises.resolve4 = async () => ['127.0.0.1'];
dns.promises.resolve6 = async () => ['::1'];
require('node:module').syncBuiltinESMExports();
