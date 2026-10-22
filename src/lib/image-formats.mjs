// Shared by upload handlers, media responses and the standalone archive importer.
export const IMAGE_TYPES = Object.freeze({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' });
export const IMAGE_HEADER_BYTES = 4096;

/** Detect file signatures, never the supplied filename or MIME type.
 * @param {Uint8Array} bytes
 * @returns {'jpg' | 'png' | 'webp' | 'avif' | null}
 */
export function sniffImage(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';

  // AVIF uses an ISO-BMFF file-type box. Only inspect aligned major/compatible brands
  // inside its complete, bounded box: HEIC/MP4 and a later payload saying "avif" are not AVIF.
  if (bytes.length < 16 || ascii(4, 8) !== 'ftyp') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(0), header = 8;
  if (size === 1) {
    if (bytes.length < 24 || view.getUint32(8) !== 0) return null;
    size = view.getUint32(12); header = 16;
  }
  if (size < header + 8 || size > IMAGE_HEADER_BYTES || size > bytes.length || (size - header) % 4 !== 0) return null;
  const avifBrand = (offset) => ['avif', 'avis'].includes(ascii(offset, offset + 4));
  if (avifBrand(header)) return 'avif';
  for (let offset = header + 8; offset < size; offset += 4) if (avifBrand(offset)) return 'avif';
  return null;
}
