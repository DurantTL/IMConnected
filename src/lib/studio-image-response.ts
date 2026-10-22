import fs from 'node:fs';
import { Readable } from 'node:stream';
import { LIMITS } from './limits';
import { sniffImage, IMAGE_TYPES, IMAGE_HEADER_BYTES } from './image-formats.mjs';
import { studioCors, studioJson } from './studio-api';

/** No paths in errors; no symlink following; bounded, sniffed original image bytes. */
export async function studioImageResponse(request: Request, file: string): Promise<Response> {
  const missing = () => studioJson(request, 404, { ok: false, error: 'Photo not found.' });
  let fh: fs.promises.FileHandle;
  try { fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
  catch { return missing(); }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > LIMITS.maxPhotoMB * 1024 * 1024 || st.size < 12) { await fh.close(); return missing(); }
    const head = Buffer.alloc(IMAGE_HEADER_BYTES), { bytesRead } = await fh.read(head, 0, head.length, 0);
    const ext = sniffImage(new Uint8Array(head.subarray(0, bytesRead)));
    if (!ext) { await fh.close(); return missing(); }
    return new Response(Readable.toWeb(fh.createReadStream({ start: 0, end: st.size - 1 })) as ReadableStream, {
      headers: { 'Content-Type': IMAGE_TYPES[ext],
        'Content-Length': String(st.size), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...studioCors(request) },
    });
  } catch { await fh.close().catch(() => {}); return missing(); }
}
