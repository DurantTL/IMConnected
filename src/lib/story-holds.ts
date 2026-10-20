// When may a held story come back? (epic #25, step 2; see migration 012.) Shared by the sync and the build fallback.
// A hold exists because an editor unpublished a story in the dashboard. The running build and the table still hold its
// OLD text. An image that contains the unpublish commit either leaves the story out (draft: true) or has text published
// after it, by any path (dashboard, Studio, git, Pages CMS), so that is when the hold ends.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Hold { marker: string | null; unpublishSha: string | null; createdAt: number }

export interface BuildCommits {
  shas: Set<string>;
  /** Number of commits listed (the newest 200 when the image was built) */
  count: number;
  /** Commit time (ms) of the oldest listed commit; null when the list has no times (old format) */
  oldestMs: number | null;
}

/** The list is cut at this many commits (docker.yml: git log -200). */
export const COMMIT_WINDOW = 200;
/** Allowed gap between a hold's creation and the unpublish commit it describes (clock differences, commit order). */
export const WINDOW_MARGIN_MS = 10 * 60 * 1000;

let commits: BuildCommits | null | undefined;

/** Parse a commit list: "<40 hex> <unix seconds>" per line (the old "<40 hex>" alone is accepted too, without a time). Other lines are ignored. */
export function parseCommits(text: string): BuildCommits | null {
  const shas = new Set<string>();
  const times: number[] = [];
  let timed = true;
  let count = 0;
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{40})(?: (\d{1,12}))?$/i.exec(line.trim());
    if (!m) continue;
    count++;
    shas.add(m[1].toLowerCase());
    if (m[2] === undefined) timed = false;
    else times.push(Number(m[2]) * 1000);
  }
  if (!count) return null;
  return { shas, count, oldestMs: timed && times.length ? Math.min(...times) : null };
}

/**
 * The commits the running image was built from, from the file the Docker build writes (/app/.build-commits, see the
 * Dockerfile and docker.yml), or BUILD_COMMITS_FILE. Null when there is no such file or it is empty (a local or dev
 * build). Read once per process.
 */
export function buildCommits(): BuildCommits | null {
  if (commits !== undefined) return commits;
  const candidates: string[] = [];
  if (process.env.BUILD_COMMITS_FILE) candidates.push(path.resolve(process.env.BUILD_COMMITS_FILE));
  else {
    candidates.push(path.resolve('.build-commits'));
    try {
      let dir = path.dirname(fileURLToPath(import.meta.url));
      for (let i = 0; i < 4; i++, dir = path.dirname(dir)) candidates.push(path.join(dir, '.build-commits'));
    } catch { /* not a file URL */ }
  }
  commits = null;
  for (const file of candidates) {
    try {
      const parsed = parseCommits(fs.readFileSync(file, 'utf8'));
      if (parsed) { commits = parsed; break; }
    } catch { /* try the next */ }
  }
  return commits;
}

/**
 * True while the story must stay hidden. `currentMarker` is the running build's marker, or null when it could not
 * be worked out (only used by builds without a commit list). Fails safe: anything unclear means hidden.
 *  - no unpublish commit recorded: hidden;
 *  - the image's commit list has it: released;
 *  - a list without it: hidden, unless the list is a full window (200) whose oldest commit is more than 10 minutes
 *    newer than the hold, which means the unpublish is older than the window and so is in the build: released;
 *  - no list (local build): released only when the marker is known and differs from the hold's.
 */
export function holdActive(hold: Hold, currentMarker: string | null): boolean {
  if (!hold.unpublishSha) return true;
  const built = buildCommits();
  if (built) {
    if (built.shas.has(hold.unpublishSha.toLowerCase())) return false;
    return !(built.count >= COMMIT_WINDOW && built.oldestMs !== null && built.oldestMs > hold.createdAt + WINDOW_MARGIN_MS);
  }
  if (hold.marker === null || currentMarker === null) return true;
  return hold.marker === currentMarker;
}
