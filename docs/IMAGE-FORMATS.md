# Image formats

IMConnected accepts **JPEG, PNG, WebP and AVIF** through public submissions, editor photo uploads, Studio data-photo publishing and the agent's create/reopen APIs. Announcements and event flyers support the same formats. Existing JPEG/PNG/WebP callers need no changes.

The server detects image signatures instead of trusting supplied MIME types or filenames. AVIF recognition checks a complete ISO-BMFF `ftyp` box, including compatible `avif`/`avis` brands and extended box lengths, with a 4096-byte header bound. An MP4/HEIC file, a truncated box or text containing “avif” is not sufficient. This is signature validation, not a full image decoder. The shared parser and MIME map live in `src/lib/image-formats.mjs`, also used by the standalone archive importer.

The server stores received bytes without re-encoding, using `.jpg`, `.png`, `.webp` or `.avif` names. Photo focus/zoom and original-image links continue to work. Draft images stay private; authenticated editor previews and scoped Studio flyer copies return the right MIME type. Published media and Studio photo copies return the original bytes as `image/webp` or `image/avif` where appropriate. Traversal, authentication, scoped flyer identity checks and human publication rules remain in place. A server upgrade is required to enable the new format; existing content does not need migration.

The public form retains WebP/AVIF originals. Its existing client-side optimization still resizes large JPG/PNG camera photos before upload. Up to six photos and 10 MiB per photo remain the limits; JSON API requests retain their existing 40 MiB limit.

## Agent requests

Use the existing endpoints and photo shape:

```json
{
  "photos": [
    { "data": "data:image/webp;base64,<actual encoded bytes>", "alt": "Describe the photo" },
    { "data": "data:image/avif;base64,<actual encoded bytes>", "alt": "Describe the flyer" }
  ]
}
```

Insert this field into a valid create request or explicit reopen request; these placeholders are not complete requests or valid base64 images. `GET /api/agent/sections` now includes additive `photoFormats: ["jpg", "png", "webp", "avif"]`. Remote photo URLs remain refused by the agent API. See [create/announcement examples](AGENT-ANNOUNCEMENTS.md) and [published-story reopen requests](AGENT-REOPEN.md).

## Studio and email

Both Studio builders accept WebP/AVIF website-photo and private-flyer transfers. A WordPress copy uses a filename matching its actual MIME type, including when an imported private flyer was originally suggested as `announcement-flyer.png`. Browser downsampling that falls back to PNG also changes the filename to `.png`. Studio leaves AVIF originals unchanged during its upload preparation. WordPress itself must support the chosen upload format; its permission/type refusals still appear as transfer errors.

Modern browsers can display these formats. Email applications have varying support; Studio retains its AVIF Send Check guidance to supply a JPEG/PNG version for wider email compatibility. Adding AVIF support does not automatically create an email fallback or transcode website originals.

## Synthetic verification

`scripts/fixtures/synthetic-photo.webp` and `.avif` are generated 48×72 RGB gradients with no real photo content. They were encoded with Pillow from newly created pixels; no production files were used. No decoder dependency is added to the app.

After `npm run build`, run:

```sh
node scripts/test-image-formats.mjs
STUDIO_HTML=/workspace/utilities/imconnected.html node scripts/test-studio-image-formats.mjs
STUDIO_HTML=/workspace/tools-public/imconnected.html node scripts/test-studio-image-formats.mjs
```

The browser suite uses the Playwright/Chromium environment in [DESIGN_REVIEW.md](DESIGN_REVIEW.md). The server suite uses a disposable database/local server; the Studio suite intercepts all network requests with synthetic local/WordPress responses. Checks cover malformed headers, MIME/name mismatches, byte fidelity, publication/reopen, private/public media, archive import, browser decoding, draft persistence, and WordPress filename/encoding consistency. No real publishing, credentials or external integrations are exercised.
