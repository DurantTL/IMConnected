// Issue #100: the pure selection behind the home page "From the archive" rail. No server, no database; synthetic stories only.
import assert from 'node:assert/strict';
import { archiveRail, ARCHIVE_LINK, ARCHIVE_RAIL_SIZE } from '../src/lib/archive-rail.ts';

let checks = 0;
const check = (label, ok, detail = '') => { assert.ok(ok, `${label} ${detail}`); checks++; console.log('PASS ' + label); };
const TODAY = '2026-10-23', WINDOW = 90;
const ago = (days, from = TODAY) => { const [y, m, d] = from.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - days)); };
const story = (id, days, section = 'news', image = '') => ({ id, data: { title: id, section, date: ago(days), image, author: 'Synthetic Editor', photos: [], photoAlts: [] } });
const ids = (list) => list.map((s) => s.id);
const opts = (extra = {}) => ({ today: TODAY, recentDays: WINDOW, ...extra });

const sections = ['news', 'features', 'youth', 'kids'];
const old = Array.from({ length: 14 }, (_, i) => story(`old-${String(i).padStart(2, '0')}`, 100 + i * 17, sections[i % 5], i % 3 === 0 ? '/media/stories/x/a.png' : ''));
const recent = [story('recent-1', 1), story('recent-89', 89), story('recent-90', 90)];
const pool = [...old, ...recent, story('boundary-91', 91)];

const picked = archiveRail(pool, opts());
check('the rail holds four stories', picked.length === ARCHIVE_RAIL_SIZE, String(picked.length));
check('every pick is older than the recency window (91+ days)', picked.every((s) => s.data.date < ago(WINDOW)));
check('stories dated 90 days ago or newer are never picked', archiveRail([...recent, story('only-old', 200)], opts()).length === 0);
check('a 91 day old story qualifies', archiveRail([story('a', 91), story('b', 300)], opts()).length === 2);

check('stories already shown above are never repeated', !ids(archiveRail(pool, opts({ exclude: ids(picked) }))).some((id) => ids(picked).includes(id)));
const featuredOld = story('featured-old', 400); featuredOld.data.featured = true;
check('an old featured story already in the hero is excluded', !ids(archiveRail([...pool, featuredOld], opts({ exclude: ['featured-old'] }))).includes('featured-old'));

check('the same day gives the same set and order', ids(archiveRail(pool, opts())).join() === ids(picked).join());
check('the input order does not change the set', ids(archiveRail([...pool].reverse(), opts())).join() === ids(picked).join());
const days = Array.from({ length: 10 }, (_, i) => ids(archiveRail(pool, opts({ today: ago(-i).toISOString().slice(0, 10) }))).join());
check('different days give different sets', new Set(days).size >= 8 && days[0] !== days[1], `${new Set(days).size} distinct of 10`);

const photoPool = [...Array(6)].map((_, i) => story(`p-${i}`, 120 + i, 'news', '/media/stories/x/a.png'));
check('photo stories fill the rail before photo-less ones when sections tie', archiveRail([...photoPool, story('np-a', 130, 'news'), story('np-b', 131, 'news')], opts()).every((s) => s.data.image));
check('a photo-less story from a new section still appears (sections spread first)', archiveRail([...photoPool, story('np-a', 130, 'youth')], opts()).some((s) => s.id === 'np-a'));
check('the picks spread across sections when possible', new Set(picked.map((s) => s.data.section)).size === 4, picked.map((s) => s.data.section).join());
check('one section alone still fills the rail', archiveRail(Array.from({ length: 6 }, (_, i) => story(`n-${i}`, 120 + i)), opts()).length === 4);

const withAnnouncement = (id, days, kind) => { const x = story(id, days); x.data.announcement = { kind }; return x; };
const announced = archiveRail([...old.slice(0, 6), withAnnouncement('old-event', 200, 'event'), withAnnouncement('old-note', 210, 'announcement')], opts({ count: 20 }));
check('an old event and an old announcement never appear', !ids(announced).some((id) => id === 'old-event' || id === 'old-note') && announced.length === 6);
check('only announcements qualifying leaves the block hidden', archiveRail([withAnnouncement('e1', 200, 'event'), withAnnouncement('e2', 220, 'announcement')], opts()).length === 0);
check('three qualifying stories show three', archiveRail(old.slice(0, 3), opts()).length === 3);
check('two qualifying stories still show', archiveRail(old.slice(0, 2), opts()).length === 2);
check('one qualifying story hides the block', archiveRail([old[0], ...recent], opts()).length === 0);
check('no stories hides the block', archiveRail([], opts()).length === 0);
check('stories left after excluding the hero decide the count', archiveRail(old.slice(0, 2), opts({ exclude: [old[0].id] })).length === 0);
check('the archive link is one root-relative constant', typeof ARCHIVE_LINK === 'string' && ARCHIVE_LINK.startsWith('/'));
console.log(`\n${checks} archive rail checks passed.`);
