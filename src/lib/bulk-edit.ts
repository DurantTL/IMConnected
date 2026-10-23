// Bulk edit of a few fields on drafts and live stories (issue #89). Only the fields the editor ticks change; everything
// else is carried over as stored. Drafts go through the editor's own version-checked save (which records a revision);
// live stories go through the story writer (one transaction, rev bumped, edited_at set, search entry, cache invalidation).
// Audit entries list field NAMES only, never values.
import { getDraft, getDraftBySlug, isEditable, saveDraft, type DraftFields } from './drafts';
import { editLiveStory, validSlug } from './story-publish';
import { SECTIONS, SECTION_KEYS, getSection, isValidArea, normalizeAdditionalSections } from './site';
import { validDate } from './storyfile';
import { EditorError, ERRORS } from './messages';
import { audit } from './auth/audit';

/** What the editor ticked. A key that is absent is never touched. */
export interface EditChanges {
  /** New primary section and its category ('' when the section has none). */
  section?: { section: string; area: string };
  /** A category only, checked against each item's own section. */
  area?: string;
  add?: string[];
  remove?: string[];
  featured?: boolean;
  date?: string;
}

export type EditResult = { ok: true; title: string; slug?: string; changed: string[] } | { ok: false; reason: string; code?: 'conflict' };

/** Every form field the edit step uses; the confirmation and retry forms carry them forward. */
export const EDIT_FORM_KEYS = ['tick_section', 'e_section', 'tick_area', 'e_area', 'tick_add', 'e_add', 'tick_remove', 'e_remove', 'tick_featured', 'e_featured', 'tick_date', 'e_date'];

const AREAS = SECTIONS.flatMap((s) => (s.areas ?? []).map((a) => ({ section: s, key: a.key, label: a.label })));
const sectionLabelOf = (key: string) => getSection(key)?.label ?? key;

/** Read the ticked fields. Returns `error` (plain words) when nothing is ticked or a ticked value is not valid. */
export function parseEditChanges(form: FormData): { changes: EditChanges; error?: string } {
  const changes: EditChanges = {};
  const ticked = (k: string) => form.get(`tick_${k}`) !== null;
  const text = (k: string) => (typeof form.get(k) === 'string' ? String(form.get(k)) : '');
  const list = (k: string) => form.getAll(k).filter((v): v is string => typeof v === 'string');
  const fail = (error: string) => ({ changes: {} as EditChanges, error });
  if (ticked('section')) {
    const [section, area = ''] = text('e_section').split('|');
    if (!getSection(section) || !isValidArea(section, area || undefined)) return fail('Choose a section and category from the list.');
    changes.section = { section, area };
  }
  if (ticked('area')) {
    const area = text('e_area');
    if (!AREAS.some((a) => a.key === area)) return fail('Choose a category from the list.');
    if (changes.section) return fail('Change either the section and category together, or the category alone, not both.');
    changes.area = area;
  }
  for (const k of ['add', 'remove'] as const) {
    if (!ticked(k)) continue;
    const keys = list(`e_${k}`);
    if (!keys.length || keys.some((v) => !SECTION_KEYS.includes(v as never))) return fail(`Choose at least one section to ${k}.`);
    changes[k] = SECTION_KEYS.filter((key) => keys.includes(key));
  }
  if (changes.add?.some((key) => changes.remove?.includes(key))) return fail('A section cannot be both added and removed.');
  if (ticked('featured')) {
    const v = text('e_featured');
    if (v !== 'on' && v !== 'off') return fail('Choose whether the stories are featured or not.');
    changes.featured = v === 'on';
  }
  if (ticked('date')) {
    const d = text('e_date');
    if (!validDate(d)) return fail('Enter a valid date.');
    changes.date = d;
  }
  if (Object.keys(changes).length === 0) return fail('Tick at least one field to change.');
  return { changes };
}

/** One plain sentence per ticked field, for the confirmation page. */
export function describeChanges(c: EditChanges): string[] {
  const out: string[] = [];
  if (c.section) {
    const area = getSection(c.section.section)?.areas?.find((a) => a.key === c.section!.area)?.label;
    out.push(`Section and category: ${sectionLabelOf(c.section.section)}${area ? ` / ${area}` : ''}`);
  }
  if (c.area) out.push(`Category only: ${AREAS.find((a) => a.key === c.area)?.label} (an item whose section has no such category is skipped, with a reason)`);
  if (c.add) out.push(`Additional sections: add ${c.add.map(sectionLabelOf).join(', ')}`);
  if (c.remove) out.push(`Additional sections: remove ${c.remove.map(sectionLabelOf).join(', ')}`);
  if (c.featured !== undefined) out.push(`Featured: ${c.featured ? 'on' : 'off'}`);
  if (c.date) out.push(`Date: ${c.date}`);
  return out;
}

interface EditTarget { section: string; area?: string; column?: string; additionalSections?: string[]; featured: boolean; date: string }
interface Patch { section: string; area: string; column: string; additionalSections: string[]; featured: boolean; date: string }

/**
 * Apply the ticked changes to one item's current values; everything not ticked is carried over. A section change does not
 * move the old primary into the extras, and the new primary is dropped from the extras (the rule everywhere else, see
 * docs/MULTIPLE-SECTIONS.md). Returns the new values and the NAMES of the fields that really changed.
 */
export function applyEdit(cur: EditTarget, c: EditChanges): { ok: true; patch: Patch; changed: string[] } | { ok: false; reason: string } {
  let section = cur.section;
  let area = cur.area ?? '';
  if (c.section) { section = c.section.section; area = c.section.area; }
  if (c.area !== undefined) {
    if (!isValidArea(section, c.area)) return { ok: false, reason: `The category "${AREAS.find((a) => a.key === c.area)?.label}" does not belong to this item's section (${sectionLabelOf(section)}). Nothing was changed.` };
    area = c.area;
  }
  const extras = new Set<string>(cur.additionalSections ?? []);
  for (const k of c.add ?? []) extras.add(k);
  for (const k of c.remove ?? []) extras.delete(k);
  const additionalSections = normalizeAdditionalSections([...extras], section);
  const patch: Patch = { section, area, column: section === 'columns' ? cur.column ?? '' : '', additionalSections, featured: c.featured ?? cur.featured, date: c.date ?? cur.date };
  const before = normalizeAdditionalSections(cur.additionalSections ?? [], cur.section);
  const changed: string[] = [];
  if (patch.section !== cur.section) changed.push('section');
  if (patch.area !== (cur.area ?? '')) changed.push('area');
  if (patch.column !== (cur.column ?? '')) changed.push('column');
  if (JSON.stringify(before) !== JSON.stringify(additionalSections)) changed.push('additionalSections');
  if (patch.featured !== cur.featured) changed.push('featured');
  if (patch.date !== cur.date) changed.push('date');
  return { ok: true, patch, changed };
}

const CONFLICT_REASON = 'Version conflict: this draft was changed after the list loaded, so nothing was changed. Open it to review the changes.';
const writeFailed = (err: unknown) => {
  console.error('[bulk] edit failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
  return { ok: false as const, reason: ERRORS.generic };
};

/** Edit the ticked fields of one new or in-review draft through the editor's own version-checked save (it records a revision). */
export function editDraftItem(draftId: number, version: number, changes: EditChanges, userId: number, ip: string): EditResult {
  const draft = getDraft(draftId);
  if (!draft) return { ok: false, reason: ERRORS.draft_gone };
  if (!isEditable(draft)) return { ok: false, reason: 'Only a new or in-review draft can be edited. This one is closed.' };
  if (version !== draft.updatedAt) return { ok: false, reason: CONFLICT_REASON, code: 'conflict' };
  const applied = applyEdit(draft, changes);
  if (!applied.ok) return applied;
  const title = draft.title || 'Untitled story';
  if (applied.changed.length === 0) return { ok: true, title, changed: [] };
  // An explicit whitelist of editorial fields (never contact details). storyBlocks and announcement stay undefined so the save keeps them.
  const fields: DraftFields = {
    title: draft.title, dek: draft.dek, section: applied.patch.section, additionalSections: applied.patch.additionalSections, area: applied.patch.area,
    column: applied.patch.column, author: draft.author, authorTitle: draft.authorTitle, church: draft.church, date: applied.patch.date,
    photoCredit: draft.photoCredit, photoLayout: draft.photoLayout, featured: applied.patch.featured, body: draft.body,
  };
  try {
    const r = saveDraft(draft.id, version, fields, new Map(), userId);
    if (!r.ok) return r.reason === 'conflict' ? { ok: false, reason: CONFLICT_REASON, code: 'conflict' } : { ok: false, reason: r.message };
  } catch (err) {
    return writeFailed(err);
  }
  try {
    audit('draft.bulk_edit', { userId, target: `draft:${draft.id}`, detail: { fields: applied.changed }, ip });
  } catch { /* the audit entry is a convenience */ }
  return { ok: true, title, changed: applied.changed };
}

/** Edit the ticked fields of one live story through the story writer. Refused when an open draft is linked to it. */
export function editStoryItem(slug: string, changes: EditChanges, userId: number, ip: string): EditResult {
  if (!validSlug(slug)) return { ok: false, reason: ERRORS.slug_bad };
  let changed: string[] = [];
  let refusal = '';
  try {
    const out = editLiveStory(slug, (story) => {
      if (story.status !== 'live') { refusal = 'This story is not on the site, so it cannot be edited here.'; return null; }
      const linked = [getDraftBySlug(slug), story.draftId !== undefined ? getDraft(story.draftId) : null];
      if (linked.some((d) => d && isEditable(d))) {
        refusal = 'An open draft exists for this story. Edit it there, so the draft and the live story do not drift apart.';
        return null;
      }
      const applied = applyEdit(story, changes);
      if (!applied.ok) { refusal = applied.reason; return null; }
      changed = applied.changed;
      if (changed.length === 0) return null;
      return {
        section: applied.patch.section, area: applied.patch.area || undefined, column: applied.patch.column || undefined,
        additionalSections: applied.patch.additionalSections, featured: applied.patch.featured, date: applied.patch.date,
      };
    });
    if (!out) return { ok: false, reason: ERRORS.story_missing };
    if (refusal) return { ok: false, reason: refusal };
    if (changed.length) {
      try {
        audit('story.bulk_edit', { userId, target: `story:${slug}`, detail: { fields: changed }, ip });
      } catch { /* the audit entry is a convenience */ }
    }
    return { ok: true, title: out.title, slug, changed };
  } catch (err) {
    if (err instanceof EditorError) return { ok: false, reason: err.message };
    return writeFailed(err);
  }
}
