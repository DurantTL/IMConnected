# Events, website navigation and editorial queues

## Public homepage

The **On our calendar** rail appears above Top stories when published events exist. It shows up to six events, ordered by event date with undated events last. Past events are omitted using the conference's America/Chicago calendar day, including daylight saving time. Ordinary announcements, unpublished stories and draft-only stories never enter this rail. Publish an Event with its first photo to include a full-aspect flyer; stored photo zoom/pan is retained but is not applied to this flyer.

Previous/Next buttons, swipe/scroll and arrow keys on the focused rail provide deliberate navigation. There is no autoplay. Without JavaScript, all event cards remain readable in the scrollable rail. The subtle card entrances, navigation underline and expanding phone menu take movement ideas from [durant.xyz](https://durant.xyz/); they copy no portfolio content or dependencies. Reduced motion disables spatial entrance and menu transitions and makes rail navigation instant. Content never waits hidden for an animation script.

## Website menu

Administrators open **Website menu** at `/admin/navigation`. Editors cannot read or change these settings.

- Change labels, public addresses, visibility and order. Use the arrow buttons or numbered positions. Clear both a label and address to remove its row; fill a blank row to add a link.
- Keep between one and twelve links, with at least one visible. Addresses accept a root-relative public path or full HTTPS URL. Private `/admin` and `/api` destinations, credentials and executable URL schemes are refused.
- **Save website menu** updates desktop and phone navigation together. **Restore default menu** restores the central section links. Search and Submit a Story remain separately available.
- Two administrators cannot silently overwrite each other: a stale save returns a conflict and reloads the current configuration for review. Changes are audited without storing labels or addresses in the audit entry.

Migration 023 stores the singleton configuration in the existing SQLite database. The section/category definitions still live in `src/lib/site.ts`; menu changes do not rename sections or move stories. Saving invalidates the origin's page cache. Previously cached or prerendered pages refresh their links from public `GET /api/navigation`, which returns only visible items and their configuration version, without cookies or private settings. Without JavaScript, prerendered pages retain the build's default navigation. An already cached page can retain its prior links until refresh; the server's next uncached render uses the saved menu.

## Separate editor screens

**Stories** (`/admin`), **Announcements** (`/admin/announcements`) and **Events** (`/admin/events`) each have their own draft list, open count and New action. Status, section and AI-agent source filters remain available. **All drafts** provides a combined oversight view. New announcement/event actions create typed In review drafts, not live content. Changing a draft's type in Story settings moves it to the corresponding queue after saving. Publishing and existing agent/Studio contracts retain their human review rules.

## Module quick access

In a modular draft's Content panel, the module library offers Writing, Images & video, Layout, Links and Favorites categories plus search. Open **Customize quick access** to choose Favorites. Those choices belong to this browser's local storage and persist across reloads; they do not modify, autosave or publish the draft. If storage is blocked, the editor explains that preferences last only for the current page. **Clear filters** returns to all eleven module types. Existing module content, ordering and undo history are unaffected by library preferences.

## Verification

After `npm run build`, run `scripts/test-community-navigation.mjs` with the Playwright/Chromium and optional axe environment described in `DESIGN_REVIEW.md`. It starts an isolated built server, seeds disposable synthetic data and blocks external browser requests. Coverage includes roles and Origin checks, safe URLs, concurrent saves, cache invalidation, moved custom links, separate queues, typed draft creation, event selection/flyers, keyboard and reduced motion, no-JavaScript reading, module preference persistence and unchanged live story rows.
