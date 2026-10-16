import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
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
    /** Path under /public, e.g. /images/stories/my-story/photo-1.jpg */
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    photoCredit: z.string().optional(),
    /** Extra photos shown in a gallery below the story */
    photos: z.array(z.string()).default([]),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

export const collections = { stories };
