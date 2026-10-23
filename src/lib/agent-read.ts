// Read-back for the AI agent: what a draft the agent created holds right now, whitelisted field by field.
// Never included: submitter contacts, the agent's private note, editor/reject notes, revision history, upload
// paths or URLs, photo bytes, module JSON, and any draft whose source is not `agent`.
import { getDb } from './db';
import { getDraft, listPhotos, type Draft } from './drafts';
import { siteUrl } from './draft-http';

export function agentDraftView(draft: Draft, editorTouched: boolean) {
  return {
    id: draft.id,
    status: draft.status,
    createdAt: new Date(draft.createdAt).toISOString(),
    updatedAt: new Date(draft.updatedAt).toISOString(),
    /** True once a person has worked on it or it has left `new`: the agent can no longer overwrite it. */
    editorTouched,
    slug: draft.slug,
    url: draft.live && draft.slug ? `${siteUrl()}/stories/${draft.slug}/` : null,
    sourceUrl: draft.sourceUrl,
    title: draft.title,
    dek: draft.dek,
    body: draft.body,
    section: draft.section,
    area: draft.area,
    additionalSections: draft.additionalSections ?? [],
    author: draft.author,
    authorTitle: draft.authorTitle,
    photoCredit: draft.photoCredit,
    featured: draft.featured,
    church: draft.church,
    date: draft.date,
    photoLayout: draft.photoLayout,
    announcement: draft.announcement ?? null,
    hasModules: !!draft.storyBlocks?.length,
    photos: listPhotos(draft.id).map((p) => ({
      position: p.position,
      alt: p.alt,
      // Dimensions are not stored for draft photos, so width and height are left out.
      format: p.ext ?? (p.url ? (/\.([a-z0-9]+)(?:[?#].*)?$/i.exec(p.url)?.[1]?.toLowerCase() ?? null) : null),
      focalX: p.focalX,
      focalY: p.focalY,
      zoom: p.zoom,
      fit: p.fit,
      fitFill: p.fitFill,
    })),
  };
}

type View = ReturnType<typeof agentDraftView>;

function viewOf(id: number): View | null {
  const draft = getDraft(id);
  if (!draft || draft.source !== 'agent') return null;
  const row = getDb().prepare('SELECT updated_by FROM drafts WHERE id = ?').get(id) as { updated_by: number | null };
  return agentDraftView(draft, draft.status !== 'new' || row.updated_by !== null);
}

export function readAgentDraftById(id: number): View | null {
  return viewOf(id);
}

/** `sourceUrl` must already be normalized (normalizeSourceUrl). */
export function readAgentDraftBySourceUrl(sourceUrl: string): View | null {
  const row = getDb().prepare("SELECT id FROM drafts WHERE source = 'agent' AND source_url = ?").get(sourceUrl) as { id: number } | undefined;
  return row ? viewOf(Number(row.id)) : null;
}
