import type { APIRoute } from 'astro';
import fs from 'node:fs';
import { getPhoto, uploadFile } from '../../../../lib/drafts';

export const prerender = false;

const TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// Uploaded draft photos live outside public/ and are served only here, to signed-in editors (the
// middleware guards /api/admin/*). The type comes from the sniffed extension chosen at upload.
export const GET: APIRoute = ({ params }) => {
  const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const id = /^\d{1,12}$/.test(params.id ?? '') ? Number(params.id) : null;
  const photo = id === null ? null : getPhoto(id);
  const type = photo?.ext ? TYPES[photo.ext] : undefined;
  const file = photo?.path ? uploadFile(photo.path) : null;
  if (!photo || !type || !file) return notFound();
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return notFound();
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': type,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
    },
  });
};
