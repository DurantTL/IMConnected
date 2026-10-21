// Which photo GET /api/studio-photo may read for IMConnected Studio: only a story photo that /api/stories returns
// for a LIVE story, i.e. /images/stories/<slug>/<file> (the build's static copy, dist/client) or
// /media/stories/<slug>/<file> (DATA_DIR/media). Draft uploads live elsewhere and can never match.
import fs from 'node:fs';
import path from 'node:path';
import { builtClientDir } from './story-sync';
import { resolveMediaFile, MEDIA_TYPES } from './media';

const PHOTO_PATH = /^\/(images|media)\/stories\/([A-Za-z0-9][A-Za-z0-9._-]{0,150})\/([A-Za-z0-9][A-Za-z0-9._-]{0,150}\.(?:jpe?g|png|webp))$/i;

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
  return { kind: m[1].toLowerCase() as 'images' | 'media', slug: m[2], file: m[3], path: p };
}

/** A built static photo inside dist/client/images/stories, symlinks refused, or null. */
function builtStoryPhoto(slug: string, file: string): string | null {
  const client = builtClientDir();
  if (!client) return null;
  try {
    const root = fs.realpathSync(path.join(client, 'images', 'stories'));
    const lexical = path.join(root, slug, file);
    if (fs.lstatSync(lexical).isSymbolicLink()) return null;
    const real = fs.realpathSync(lexical);
    if (real !== lexical || !real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

export function resolveStudioPhoto(src: string, siteOrigin: string): string | null {
  const p = photoPathFromSrc(src, siteOrigin);
  if (!p) return null;
  if (p.kind === 'images') return builtStoryPhoto(p.slug, p.file);
  return resolveMediaFile(p.path.slice('/media/'.length))?.file ?? null;
}

export { MEDIA_TYPES };
