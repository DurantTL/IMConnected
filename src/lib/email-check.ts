// Email domain checks for the submit form: throwaway-domain blocklist, typo hints and a DNS lookup.
import { resolveMx, resolve4, resolve6 } from 'node:dns/promises';
import disposableList from './disposable-domains.txt?raw';

export class EmailCheckError extends Error {}

const DISPOSABLE = new Set(
  disposableList
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#')),
);

/** The part after the last "@", lower-cased, without a trailing dot. */
export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).trim().toLowerCase().replace(/\.$/, '');
}

/** True when the domain, or any parent domain of it, is on the blocklist. */
export function isDisposableDomain(domain: string): boolean {
  const parts = domain.toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (DISPOSABLE.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

const TYPOS: Record<string, string> = {
  'gmail.con': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gmail.cm': 'gmail.com',
  'gamil.com': 'gmail.com',
  'yaho.com': 'yahoo.com',
  'yahoo.con': 'yahoo.com',
  'yahooo.com': 'yahoo.com',
  'hotmial.com': 'hotmail.com',
  'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outlook.con': 'outlook.com',
};

/** A corrected domain for a common typo, or null. */
export function suggestDomain(domain: string): string | null {
  return TYPOS[domain.toLowerCase()] ?? null;
}

/** DNS lookups used by the check. Injectable so tests need no network. */
export interface Resolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

export const systemResolver: Resolver = { resolveMx, resolve4, resolve6 };

const DNS_TIMEOUT_MS = 3000;
// RFC 2606 / 6761 names that can never be real mail domains; no lookup needed.
const RESERVED_TLDS = new Set(['invalid', 'test', 'example', 'localhost', 'local']);

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), DNS_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const code = (e: unknown) => (e as { code?: string })?.code;

/**
 * 'ok' when the domain can plausibly receive mail (an MX record, or else an A/AAAA record);
 * 'missing' when it doesn't exist or has no mail records; 'unknown' when DNS itself failed (fail open).
 */
export async function domainCanReceiveMail(domain: string, resolver: Resolver = systemResolver): Promise<'ok' | 'missing' | 'unknown'> {
  if (!domain || !domain.includes('.')) return 'missing';
  if (RESERVED_TLDS.has(domain.split('.').pop()!)) return 'missing';

  try {
    const mx = await withTimeout(resolver.resolveMx(domain));
    const real = mx.filter((m) => m.exchange && m.exchange !== '.');
    if (real.length > 0) return 'ok';
    if (mx.length > 0) return 'missing'; // a "null MX" (RFC 7505): the domain accepts no mail
  } catch (e) {
    if (code(e) === 'ENOTFOUND') return 'missing'; // NXDOMAIN
    if (code(e) !== 'ENODATA') return 'unknown'; // timeout, SERVFAIL, refused...
  }

  let sawFailure = false;
  for (const lookup of [resolver.resolve4, resolver.resolve6]) {
    try {
      const records = await withTimeout(lookup.call(resolver, domain));
      if (records.length > 0) return 'ok';
    } catch (e) {
      if (code(e) !== 'ENODATA' && code(e) !== 'ENOTFOUND') sawFailure = true;
    }
  }
  return sawFailure ? 'unknown' : 'missing';
}

/** Throws EmailCheckError (shown to the submitter) when the address should be refused. */
export async function checkEmail(email: string, resolver: Resolver = systemResolver): Promise<void> {
  const domain = emailDomain(email);
  const suggestion = suggestDomain(domain);
  if (suggestion) {
    throw new EmailCheckError(`Did you mean ${email.slice(0, email.lastIndexOf('@') + 1)}${suggestion}? Please check the spelling of your email address.`);
  }
  if (isDisposableDomain(domain)) {
    throw new EmailCheckError("Please use a personal or church email address — temporary inboxes can't receive our confirmation.");
  }
  if ((await domainCanReceiveMail(domain, resolver)) === 'missing') {
    throw new EmailCheckError("We couldn't find that email domain. Please check the spelling.");
  }
}
