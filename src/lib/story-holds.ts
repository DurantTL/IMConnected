// When may a held story come back? (epic #25, step 2; see migration 012.) Shared by the sync and the build fallback.
// A hold exists because an editor unpublished a story. The running build and the table still hold its OLD text, so
// publishing it again in the dashboard must not bring it back until a deploy that contains the republish commit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Hold { marker: string | null; republishSha: string | null }

let commits: Set<string> | null | undefined;

/**
 * The commits (newest 200 on main) the running image was built from, from the file the Docker build writes
 * (/app/.build-commits, see the Dockerfile and docker.yml), or BUILD_COMMITS_FILE. Null when there is no such file
 * or it is empty (a local or dev build). Read once per process.
 */
export function buildCommits(): Set<string> | null {
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
      const shas = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => /^[0-9a-f]{40}$/.test(l));
      if (shas.length) { commits = new Set(shas); break; }
    } catch { /* try the next */ }
  }
  return commits;
}

/**
 * True while the story must stay hidden. `currentMarker` is the running build's marker, or null when it could not
 * be worked out (only used by builds without a commit list). Fails safe: anything unclear means hidden.
 *  - no republish recorded: hidden;
 *  - republish recorded and the image's commit list has it: released; a non-empty list without it: hidden;
 *  - no commit list (local build): released only when the marker is known and differs from the hold's.
 */
export function holdActive(hold: Hold, currentMarker: string | null): boolean {
  if (!hold.republishSha) return true;
  const built = buildCommits();
  if (built) return !built.has(hold.republishSha.toLowerCase());
  if (hold.marker === null || currentMarker === null) return true;
  return hold.marker === currentMarker;
}
