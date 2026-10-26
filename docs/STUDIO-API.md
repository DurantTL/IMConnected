# Publishing from IMConnected Studio

The APIs IMConnected Studio uses to publish newsletter stories, import the story list and copy photos. See also [STUDIO-IMPORT.md](STUDIO-IMPORT.md).


The communication director builds each newsletter in IMConnected Studio. Clicking **Publish to IMConnected** sends the ticked stories to `POST /api/publish`, which writes them to the database (one transaction for the whole request, photos copied to `DATA_DIR/media`), so they are live on the very next request. Studio then uses the returned story URLs in the email's "Read full story" buttons. Studio publishes are also recorded in the dashboard (a published draft with source Studio, credited to "IMConnected Studio" through a `published_via_studio` flag that a later dashboard publish clears; publishing the same story again updates that row). If an editor's draft for the same story is still new or in review, Studio never touches its text, status or photos: the draft only gets the live markers, an audit entry `draft.studio_overwrote_live`, and a notice on the draft ("IMConnected Studio published over this story on <date>; your saved edits here are not live."; migration 006). A closed linked draft (published or rejected) is updated in place (a rejected draft's uploaded photos are replaced and their files deleted), so `/admin` shows the full history. If the database is unavailable the publish fails with a 502 and nothing is published (the stories and the dashboard records are one transaction).

**Setup**

1. Generate a secret of 32+ random characters (`openssl rand -hex 32`) and set it as `PUBLISH_TOKEN` in the server's `.env`. Enter the same value in Studio. Without a token of at least 32 characters, every call returns 503.
2. Set `PUBLISH_ORIGINS` to the browser origins allowed to call the API (default `https://tools.imsda.org`).

**API** (JSON, `Authorization: Bearer <PUBLISH_TOKEN>`)

- `GET /api/publish` returns `{ok, site, sections}` for a connection test and the section list.
- `POST /api/publish` takes `{newsletter:{name,issueDate}, stories:[{ref,title,section,area,author,dek,body,quote,attribution,photos:[{url,alt,caption}]}]}` (1-12 stories, up to 6 photos each, 40 MB total). Each photo's `alt` is published (the first as `imageAlt`, the rest as `photoAlts`). Optional `photoLayout` per story (`one`, `twoUp`, `heroGrid`, `mosaic`, `stack`, `carousel` or `threeUp`; Studio sends the story block's `layout` unchanged) sets how the story page arranges the photos; it defaults to `one` when left out (or `null`), and any other value is a `400` that names the choices. A republish of an existing story takes the layout that request carries (default `one`), like every other field. Photos are `https://` links (stored as-is, never downloaded) or `data:` JPG/PNG/WebP/AVIF images (checked by file signature and copied to `DATA_DIR/media/stories/<slug>/<sha256>.<ext>`).
- Slugs are `<issueDate>-<title>`, so publishing the same issue again updates its stories (`status: "updated"`) instead of duplicating them. If any story is invalid the response is `400` with a `ref` and nothing is written.
- Publishing the same newsletter again overwrites those stories on the site, including any edits made to them in the dashboard and their `featured` setting.
- All text goes through the same escaping as the submit form. Never HTML.

**Timing:** a story is live on the very next request, in the story page, its section page, the home page, `/stories.json`, `/rss.xml`, search and `/api/stories`. The URL returned by the API works at once. The response still has a `commit` key, always `null` now (there is no commit), so older Studio builds that read it do not break.

**Testing locally:** run the server with a throwaway `DATA_DIR`, `AUTH_SECRET` and a made-up `PUBLISH_TOKEN`, then `curl` the endpoint. Never point tests at the real site.

### Story list for Studio

`GET /api/stories?limit=50&section=<key>` is what Studio's **Import from IMConnected** button reads. It uses the same bearer token and the same CORS rules as `/api/publish`: `Authorization: Bearer <PUBLISH_TOKEN>`, and only origins in `PUBLISH_ORIGINS` get CORS headers (the `OPTIONS` preflight included; other origins get none). 503 when `PUBLISH_TOKEN` is unset or short, 401 when wrong, 120 requests per IP per hour. `limit` is 1-100 (default 50); an unknown `section` is a 400.

```json
{ "ok": true, "version": 1, "site": "https://stories.imadventist.org/", "generated": "…",
  "stories": [ { "id": "…", "url": "…", "title": "…", "…": "every /stories.json field", "status": "published", "source": "site", "excerpt": "…" } ],
  "drafts":  [ { "id": 12, "status": "new", "source": "agent", "title": "…", "…": "the same fields, no url", "excerpt": "…" } ] }
```

- **`stories`** are the live stories, newest first, each with exactly the `/stories.json` fields (`feedItem` in `src/lib/feed.ts`) plus `status: "published"` and `source` (`site` for a story imported from git, otherwise the story's source: `form`, `studio`, `editor` or `agent`). Nothing is renamed, so `/stories.json` stays the public contract.
- **`excerpt`** (on every story and draft, Studio list only; `/stories.json` and `/rss.xml` are unchanged) is the body's first non-empty paragraph as plain text: Markdown headings, emphasis, blockquote markers and images removed, link text kept, HTML entities decoded (`&lt;` becomes `<`), whitespace collapsed, at most 400 characters cut at a word boundary with `…`. It is an empty string when there is no body. Studio treats it as text, never as HTML (`src/lib/excerpt.ts`).
- **How "live" is read.** Straight from the `stories` table (live, non-draft rows), never from the page cache, so a publish or unpublish, even one made by another process, shows on the next call. `/admin/published` reads the same rows. A draft that is being edited again keeps its live text, never its unpublished edits. If the table can't be read the answer is 503.
- **`drafts`** are the 20 newest `new` and `in_review` drafts (the same item shape, `id` is the draft id, no `url` because they aren't live), so Studio can show "not published yet". Only whitelisted fields are copied: a submitter's name, email, phone and church are never included, and neither are the agent's note or source link. A draft gets an `image` only when its lead photo is a file the site serves without a login (an `/images/...` or `/media/...` path); photos uploaded to a draft live outside `public/` and are only served to signed-in editors, so they are left out. Open announcements/events may additionally include a `draftFlyer` descriptor containing only `draftId`, `photoId`, stable `key` and `alt`; the new authenticated transfer below reads that lead flyer without making its upload public.

#### Photo bytes for Studio

`GET /api/studio-photo?src=<url>` returns a story photo so Studio can upload it to the WordPress media library (browsers can't read the static photo files, which have no CORS headers). Studio copies the permitted photos selected by the director, so the limit of 300 requests per IP per hour is ample. Same bearer token (`PUBLISH_TOKEN`) and CORS rules as `/api/stories` (503 unconfigured, 401 wrong token, `OPTIONS` preflight 204, other methods 405; 429 over the limit). `src` is one of the photo URLs `/api/stories` returns (`image` or an entry of `photos`): an absolute URL on the site's own origin (`SITE_URL`) or a root-relative path, and only `/media/stories/<slug>/<file>` (`DATA_DIR/media`, where every published photo is) or the older `/images/stories/<slug>/<file>` (the frozen archive in `dist/client`, else the story's own `/media` copy found through its photo list), with plain `[A-Za-z0-9._-]` names and a `.jpg`, `.jpeg`, `.png`, `.webp` or `.avif` extension. The file must be a regular file inside those folders (a symlink in the built `images/stories` folder is refused; for `/media` the real path must stay inside the media folder, same rule as `GET /media/*`) and its bytes must be a JPEG, PNG, WebP or AVIF no larger than the photo size limit. Refusals are `404 {"ok": false, "error": "Photo not found."}`. There is no "not built yet" case any more: a photo published to the database is served at once. A draft's uploaded photos are served only to signed-in editors and can't be reached here. The 200 carries the sniffed `Content-Type`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

#### Unpublished announcement flyers for Studio

`GET /api/studio-draft-flyer?draftId=<id>&photoId=<id>&key=<media_key>` uses the same Studio bearer authentication, CORS and 300/IP/hour limit as photo transfer. Its descriptor comes only from the authenticated Studio list. It serves only the current lead upload of an open (`new` / `in_review`) typed announcement/event. Closed drafts, ordinary drafts, gallery positions, changed identities, reused IDs, traversal, symlinks, unsupported/oversized bytes and missing files cannot be read. Successful bytes are `no-store`; this grants no public or AI-agent photo access and exposes no upload path or submitter contact details.

Studio imports typed announcements/events into its **Announcements & events** flyer cards, retaining date/location, three actions and a supported video link. The flyer stays at full aspect in email, website HTML and WordPress block export. Published cards retain their website link; draft cards remain labelled for human review. Imported cards cannot overwrite full website stories through Studio's publish flow.

For a private draft flyer, Studio fetches bytes with its session token and copies them to WordPress when connected. Otherwise it attempts a bounded local preview (existing image resizing, at most 1.5 MiB before base64, then an actual storage-quota check). Send Check flags local images until replaced with a public WordPress URL. Oversized/quota failures are explicit, never falsely reported as saved. Removal/replacement during download cancels attachment/upload; manual replacement clears transfer errors, and interrupted transfers become actionable errors on reload. Tokens and the private descriptor are not saved with the newsletter.

