# Security and spam protection


- Story text has HTML escaped and link syntax neutralized, because Astro renders raw HTML in `.md` files.
- Photos are checked by file signature (JPG, PNG, WebP or AVIF only), up to 6 photos at 10 MB each. The public form shrinks large JPG/PNG photos to a 2000 px long edge before upload; WebP and AVIF originals are retained. The server stores the received bytes unchanged.
- Spam protection: a hidden honeypot field, a minimum time to fill out the form, an Origin check, a per-IP hourly limit (`SUBMIT_RATE_LIMIT`), Cloudflare Turnstile, email domain checks and a confirmation email (see [Submissions and Studio in the dashboard](EDITOR-GUIDE.md#submissions-and-studio-in-the-dashboard)).
- Submitter email addresses and phone numbers live only in the dashboard database and the editor-only submitter panel (never in a pull request: there are none now). They are never logged, never in a story row, and never in the editor notification emails.
- There is no GitHub token to protect: the app makes no GitHub call.
- Photos are files in `DATA_DIR/media` (on the data volume, included in the nightly backup). If that folder ever gets large, move it to object storage and store URLs in `story_photos.url` instead.

