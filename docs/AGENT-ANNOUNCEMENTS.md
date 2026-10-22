# Announcements, event flyers, links and videos

The agent submits to `POST /api/agent/stories` with its existing bearer authentication. These requests create **new drafts** for an editor. A person reviews and publishes them. The agent cannot publish, submit raw modules or upload iframe HTML.

An administrator configures `AGENT_API_TOKEN` as described in the [README](../README.md#ai-agent-api). `GET /api/agent/sections` returns valid categories and announcement capabilities. Use the same token for both endpoints; store it in the agent's secure configuration.

## Request example

This is a complete synthetic event request. The tiny PNG is a test placeholder; replace its data URI with the base64 bytes of the actual flyer. Send JPG, PNG, WebP or AVIF, up to six images at 10 MB each, within the 40 MB JSON request limit. The site never downloads remote image URLs. PDF, SVG and raw HTML are not accepted as photos.

```json
{
  "title": "Synthetic community gathering",
  "dek": "An example announcement for testing the editorial workflow.",
  "body": "This is a synthetic event example, not an invitation to a real event. Include the details from the flyer here so readers can access them without reading text inside an image.",
  "author": "Synthetic Editor",
  "section": "news",
  "area": "conference",
  "date": "2026-10-22",
  "sourceUrl": "https://example.invalid/source/synthetic-event",
  "note": "Synthetic example; please verify all event details before publishing.",
  "announcement": {
    "kind": "event",
    "eventDate": "2026-12-01",
    "location": "Synthetic Hall",
    "links": [
      { "label": "Registration details", "url": "https://example.invalid/register" }
    ],
    "videoUrl": "https://www.youtube.com/watch?v=abcdefghijk"
  },
  "photos": [
    {
      "data": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=",
      "alt": "Synthetic event flyer placeholder; event details are in the story text."
    }
  ]
}
```

`announcement.kind` is `announcement` or `event`. Dates are real `YYYY-MM-DD` calendar dates. Date and location are optional; location is at most 200 characters. Up to three links are allowed, each with a nonempty label (120 characters) and an absolute `http://`, `https://`, `mailto:` or `tel:` address (2,048 characters). Credentials, script/data addresses and protocol-relative links are rejected.

`videoUrl` is optional. Supported sources are HTTPS YouTube watch, share, shorts or embed URLs and Vimeo numeric public-video URLs. Paste the normal video link; readers press **Play** to open an embedded player in a popup. The server derives the embed URL from the provider and video ID; arbitrary hosts and iframe HTML are rejected. Extra query options such as start times are not retained. Provider restrictions, deleted/private videos and content blockers can prevent playback; the normal provider link remains available. No external player loads before that click. Close, Escape or clicking the backdrop stops playback and returns focus to the opener. The editor's script-disabled preview displays provider links instead of live players. This uses the browser's native dialog without a React dependency.

## Updates and review

For an already published story, announcement or event, use the explicit [`POST /api/agent/stories/reopen` workflow](AGENT-REOPEN.md). It accepts partial metadata changes and appends new photos to an In review draft without changing the live website. A requestId protects retries; active/rejected drafts cannot be overwritten. An editor must review and publish the update.

The same `sourceUrl` updates the same draft while it is still new and untouched by an editor. Omitting `announcement` preserves its previous metadata; sending `"announcement": null` changes it back to an ordinary story. Sending an announcement object replaces that metadata, so include the links and video you want to keep. Omitting `photos` preserves the existing photos; `photos: []` removes them. Responses remain `201 created/updated`, `400 bad_announcement` for invalid announcement data, `401` for failed authentication, `409 already_reviewed` once a person starts editing, `429` for the shared 60/hour rate limit, and `503` when unavailable. Other existing validation errors are unchanged.

The first photo is the optional flyer. It displays at its full aspect ratio, including when placed with `{{photo 1}}`, a gallery, or an existing Image module. Its saved crop metadata and original bytes are retained; the flyer display does not crop away printed text. Reordering the lead photo changes which image is treated as the flyer. Provide a meaningful description and repeat essential flyer details in the body.

## Editor workflow

In **Story settings**, choose Announcement or Event and review the date, location, link buttons and video URL. In **Photo studio**, upload/reorder images and edit their descriptions. The first photo is the announcement's flyer; all photographs remain available to enlarge.

The module library also includes **Flyer**, **Video**, **Gallery**, and **Button / link**. Flyer selects a current-story photo and displays its whole image. Leave its description empty to follow the photo's current description, or enter an explicit override. Video accepts a supported provider link and a descriptive title. Button / link adds a labelled action at any point in the story. Galleries select and reorder story-owned photos with two or three columns. Duplicate, Undo and reopening published content preserve these modules and their references.

Ordinary stories can use these modules too. Announcement metadata is additive in `/stories.json` (version 1) and the authenticated Studio lists; older Studio requests retain the saved metadata. An open editor's draft is preserved when Studio replaces its live story.

## Public announcements and events page

Published announcements/events appear at `/announcements/` as well as their normal `/stories/<slug>/` detail addresses. The navigation links to the board, where readers can filter events and announcements. Drafts, unpublished stories and ordinary story types do not appear. Publishing or unpublishing invalidates the origin page cache immediately; existing browser/CDN cache lifetimes still apply. If the story database is unavailable, the page reports503 instead of showing the frozen archive.

## Studio import of the reviewed material

Studio imports typed announcements/events as flyer-style announcement/event cards with their date, location, action links and video link. Studio also has a standalone **Video** block: paste a YouTube/Vimeo URL and use **Preview video popup**. Website HTML export opens both standalone and announcement videos in a popup; email output keeps safe watch links without scripts or iframes, and the standalone WordPress export uses its native Embed block. Published flyers use the existing public-photo transfer. The communication director may also import the lead uploaded flyer of an open announcement draft through the separate Studio-token-only `/api/studio-draft-flyer` endpoint. This is not an agent endpoint and grants the agent no read or publishing rights. Local flyer previews require a public WordPress image before email delivery; failed or oversized transfers are shown explicitly. The website continues to show published announcements on the board and detail pages with uncropped flyers.
