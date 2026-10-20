// Error messages for the drafts pages. Redirects carry only the CODE (?e=<code>); the page looks the
// text up here, so a crafted link can never put its own words on an editor's screen.
export const ERRORS = {
  generic: 'Something went wrong. Please try again.',
  conflict: 'Someone else changed this draft. Reload to see their changes.',
  closed: 'This draft is closed. Restore or reopen it to edit.',
  draft_gone: 'That draft no longer exists.',
  bad_date: 'The date is not valid.',
  bad_section: 'That section does not exist.',
  photo_gone: 'That photo is no longer on this draft.',
  too_big: 'That is too much to send at once.',
  form_unreadable: 'The form could not be read.',
  stale_page: 'The page was out of date. Please try again.',
  photos_closed: 'This draft is closed. Restore it to change photos.',
  upload_none: 'Choose at least one photo to upload.',
  photo_limit: 'A story can have up to 6 photos.',
  photo_big: 'A photo is larger than 10 MB.',
  photo_type: 'Photos must be JPG, PNG or WebP images.',
  photo_op: 'That photo action is not known.',
  not_publishable: 'Only a new or in-review draft can be published.',
  no_github: 'Publishing is not set up on this server.',
  already_publishing: 'This draft is already being published.',
  publish_failed: 'We could not publish right now. Please try again in a few minutes.',
  live_not_recorded: 'The story is live, but the editor could not record that. Do not publish it again; reload this page.',
  slug_taken: 'Another story just took that address. Please publish again.',
  title_required: 'Add a title before publishing.',
  title_long: 'The title is longer than 140 characters.',
  author_required: 'Add an author before publishing.',
  author_long: 'The author name is too long.',
  dek_long: 'The summary is longer than 240 characters.',
  body_required: 'Add the story text before publishing.',
  body_long: 'The story is longer than 20000 characters.',
  section_required: 'Choose a section.',
  area_bad: 'Choose a category that belongs to this section.',
  date_required: 'Choose a valid date.',
  column_only: 'A column name is only for the Columns section.',
  photos_many: 'Use up to 6 photos per story.',
  link_unsafe: 'A link in the story is not a web, email or phone link. Use https:// addresses.',
  slug_bad: 'The story address is not valid.',
  slug_none: 'Could not find a free address for this story. Change the title and try again.',
  photo_link_bad: 'A photo link is not valid. Photos must be on this site or use an https:// link.',
  photo_missing: 'An uploaded photo is missing from the server. Delete it and upload it again.',
  photo_not_image: 'An uploaded photo is not a JPG, PNG or WebP image.',
  story_missing: 'That story was not found on the live branch.',
  edit_no_github: 'Editing live stories is not set up on this server.',
  load_failed: 'We could not load that story right now. Please try again.',
  unpublish_no_github: 'Unpublishing is not set up on this server.',
  unpublish_failed: 'We could not unpublish right now. Please try again in a few minutes.',
  unpublish_not_recorded: 'The story is unpublished in git, but this server could not record that. Do not publish it again before the next deploy; ask the site administrator.',
  hold_missing: 'This story was unpublished but its safety record is missing here. Unpublish it again, then publish.',
  no_frontmatter: 'That story file has no frontmatter, so it was left alone.',
  section_unknown: 'That story uses a section this editor does not know.',
  date_unreadable: "That story's date could not be read, so it was left alone. Fix it in the story file first.",
} as const;

export type ErrorCode = keyof typeof ERRORS;

/** An error with a code from ERRORS; the code, not the text, is what travels in a redirect. */
export class EditorError extends Error {
  constructor(public code: ErrorCode) {
    super(ERRORS[code]);
  }
}

export const errorText = (code: string | null | undefined): string => (code && Object.hasOwn(ERRORS, code) ? ERRORS[code as ErrorCode] : '');
