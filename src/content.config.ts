import { normalizeAnnouncement } from './lib/announcement';
import { storyBlockPhotos } from './lib/story-blocks';
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { OWN_PHOTO_ERROR, normalizeStoryBlocks } from './lib/story-blocks';
import { SECTION_KEYS } from './lib/site';

const stories = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/stories' }),
  schema: z.object({
    title: z.string(),
    /** One- or two-sentence summary shown under the headline and on cards */
    dek: z.string().optional(),
    section: z.enum(SECTION_KEYS),
    /** Sub-area within a section, e.g. news → churches */
    area: z.string().optional(),
    /** Column name, for section: columns */
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
    /** How the story page arranges the photos (Studio's story layouts). Missing means one: the lead photo, the others in a row. Values live in src/lib/photo-layouts.ts. */
    photoLayout: z.enum(['one', 'twoUp', 'heroGrid', 'mosaic', 'stack']).default('one'),
    announcement: z.unknown().optional().transform((value) => normalizeAnnouncement(value)),
    storyBlocks: z.unknown().optional().transform((value) => normalizeStoryBlocks(value)),
    photoFocus: z.array(z.object({ focalX: z.number().min(0).max(100), focalY: z.number().min(0).max(100), zoom: z.number().min(1).max(3).default(1) })).default([]),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
  }).superRefine((d, ctx) => {
    // An image module can only show one of the story's own photos (its lead image or gallery).
    const own = new Set([...(d.image ? [d.image] : []), ...d.photos]);
    if (storyBlockPhotos(d.storyBlocks ?? []).some((b) => b.url && (!own.has(b.url) || b.photoIndex !== undefined && [...(d.image ? [d.image] : []), ...d.photos][b.photoIndex] !== b.url))) ctx.addIssue({ code: 'custom', path: ['storyBlocks'], message: OWN_PHOTO_ERROR });
  }),
});

export const collections = { stories };
