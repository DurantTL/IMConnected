// Which photo GET /api/studio-photo may read for IMConnected Studio: a story photo path of the shapes
// /api/stories returns, i.e. /images/stories/<slug>/<file> (the build's static copy, dist/client) or
// /media/stories/<slug>/<file> (DATA_DIR/media). It does not check that the story is live: these files are
// already public on the site. Draft uploads live elsewhere (DATA_DIR/uploads) and can never match.
import fs from 'node:fs';
import path from 'node:path';
import { builtClientDir } from './story-sync';
import { resolveMediaFile } from './media';

const PHOTO_PATH = /^\/(images|media)\/stories\/([A-Za-z0-9][A-Za-z0-9._-]{0,150})\/([A-Za-z0-9][A-Za-z0-9._-]{0,150}\.(?:[Jj][Pp][Ee]?[Gg]|[Pp][Nn][Gg]|[Ww][Ee][Bb][Pp]))$/;

/** The site-relative path of a photo URL from /api/stories, or null when it is not an allowed shape or not on this site. */
export function photoPathFromSrc(src: string, siteOrigin: string): { kind: 'images' | 'media'; slug: string; file: string; path: string } | null {
  if (typeof src !== 'string' || src.length > 400) return null;
  let p: string;
  if (src.startsWith('/') && !src.startsWith('//')) p = src;
  else if (src.startsWith(siteOrigin + '/')) p = src.slice(siteOrigin.length);
  else return null;
  // Matched against the raw text: no %, backslash, ?, # or dot segments can pass the pattern.
  const m = PHOTO_PATH.exec(p);
  if (!m || m[2] === '..' || m[3] === '..') return null;
  return { kind: m[1] as 'images' | 'media', slug: m[2], file: m[3], path: p };
}

export type StudioPhoto = { file: string } | { notBuilt: true } | null;

/** A built static photo inside dist/client/images/stories, symlinks refused. `notBuilt` = nothing is there at all. */
function builtStoryPhoto(slug: string, file: string): StudioPhoto {
  const client = builtClientDir();
  if (!client) return { notBuilt: true };
  try {
    const root = fs.realpathSync(path.join(client, 'images', 'stories'));
    const lexical = path.join(root, slug, file);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(lexical);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR' ? { notBuilt: true } : null;
    }
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const real = fs.realpathSync(lexical);
    if (real !== lexical || !real.startsWith(root + path.sep)) return null;
    return { file: real };
  } catch {
    return null;
  }
}

export function resolveStudioPhoto(src: string, siteOrigin: string): StudioPhoto {
  const p = photoPathFromSrc(src, siteOrigin);
  if (!p) return null;
  if (p.kind === 'images') return builtStoryPhoto(p.slug, p.file);
  const f = resolveMediaFile(p.path.slice('/media/'.length));
  return f ? { file: f.file } : null;
}
