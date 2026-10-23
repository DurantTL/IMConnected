import { normalizeAnnouncement } from './lib/announcement';
import { storyBlockPhotos } from './lib/story-blocks';
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { OWN_PHOTO_ERROR, normalizeStoryBlocks } from './lib/story-blocks';
import { SECTION_KEYS, canonicalSectionKey } from './lib/site';

/** Issue #136: the frozen archive may still say section: columns; it is read as features. */
const sectionKey = z.preprocess(canonicalSectionKey, z.enum(SECTION_KEYS));

const stories = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/stories' }),
  schema: z.object({
    title: z.string(),
    /** One- or two-sentence summary shown under the headline and on cards */
    dek: z.string().optional(),
    section: sectionKey,
    additionalSections: z.array(sectionKey).max(20).optional(),
    /** Newsletter issue the story first appeared in (issue #98); the database holds the real value, the archive's adoption/import leave it alone. */
    newsletterIssue: z.object({ number: z.number().int().min(1).max(9999), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), title: z.string().default(''), position: z.number().int().min(1).max(999).nullable().default(null) }).optional(),
    /** Key points (issue #117): up to three short plain-text lines; the database holds the real value, the archive's adoption/import default to none. */
    keyPoints: z.array(z.string().min(1).max(160)).max(3).default([]),
    /** Sub-area within a section, e.g. news → churches */
    area: z.string().optional(),
    /** Retired (issue #136): column names are ignored; archive files may still carry one */
    column: z.string().optional(),
    author: z.string(),
    authorTitle: z.string().optional(),
    church: z.string().optional(),
    date: z.coerce.date(),
    /** Path under /public (e.g. /images/stories/my-story/photo-1.jpg) or an absolute https:// URL */
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    photoCredit: z.string().optional(),
    /** Extra photos shown in a gallery below the story (paths or https:// URLs) */
    photos: z.array(z.string()).default([]),
    /** Alt text for each of `photos`, in the same order (shorter or missing entries fall back to a generic description) */
    photoAlts: z.array(z.string()).default([]),
    /** Visible caption of the lead photo and of each of `photos` (same order). Plain text up to 300 characters, shown as a figcaption; empty means none (issue #84). */
    imageCaption: z.string().max(300).optional(),
    photoCaptions: z.array(z.string().max(300)).default([]),
    /** How the story page arranges the photos (Studio's story layouts). Missing means one: the lead photo, the others in a row. Values live in src/lib/photo-layouts.ts. */
    photoLayout: z.enum(['one', 'twoUp', 'heroGrid', 'mosaic', 'stack', 'carousel', 'threeUp']).default('one'),
    announcement: z.unknown().optional().transform((value) => normalizeAnnouncement(value)),
    storyBlocks: z.unknown().optional().transform((value) => normalizeStoryBlocks(value)),
    photoFocus: z.array(z.object({ focalX: z.number().min(0).max(100), focalY: z.number().min(0).max(100), zoom: z.number().min(1).max(3).default(1), fit: z.enum(['cover', 'contain']).default('cover'), fitFill: z.enum(['blur', 'paper', 'navy']).default('blur') })).default([]),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
  }).superRefine((d, ctx) => {
    // An image module can only show one of the story's own photos (its lead image or gallery).
    const own = new Set([...(d.image ? [d.image] : []), ...d.photos]);
    if (storyBlockPhotos(d.storyBlocks ?? []).some((b) => b.url && (!own.has(b.url) || b.photoIndex !== undefined && [...(d.image ? [d.image] : []), ...d.photos][b.photoIndex] !== b.url))) ctx.addIssue({ code: 'custom', path: ['storyBlocks'], message: OWN_PHOTO_ERROR });
  }),
});

export const collections = { stories };
