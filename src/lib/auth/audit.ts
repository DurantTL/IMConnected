import { getDb } from '../db';

/** Append to the audit log. `detail` must never hold secrets or personal data beyond the editor's id. */
export function audit(action: string, opts: { userId?: number | null; target?: string | null; detail?: Record<string, unknown>; ip?: string | null } = {}): void {
  getDb()
    .prepare('INSERT INTO audit_log (at, user_id, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), opts.userId ?? null, action, opts.target ?? null, opts.detail ? JSON.stringify(opts.detail) : null, opts.ip ?? null);
}
