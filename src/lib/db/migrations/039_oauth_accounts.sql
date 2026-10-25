-- Issue #11: Google and Microsoft 365 sign-in (invite-only). One row links a provider account to an editor.
-- provider_user_id is the provider's stable subject (Google `sub`; Microsoft `<tid>:<oid>`). email_at_link is the
-- verified address at the time of linking, kept for the editor's information only: matching never uses it again.
CREATE TABLE oauth_accounts (
  id               INTEGER PRIMARY KEY,
  provider         TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  provider_user_id TEXT NOT NULL CHECK (length(provider_user_id) BETWEEN 1 AND 200),
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_at_link    TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  UNIQUE (provider, provider_user_id)
) STRICT;
-- An editor links at most one account per provider.
CREATE UNIQUE INDEX oauth_accounts_user_provider ON oauth_accounts(user_id, provider);

-- When an account first became active (an invite accepted). It is never cleared, so an editor who is later reset to 'invited' (a
-- password-less editor after "Reset two-step sign-in") can be told apart from a never-activated invite: only the latter may be deleted by
-- "Revoke invite", because deleting a person who has worked on drafts would null updated_by/created_by/published_by, draft revisions and
-- audit entries (and let the agent overwrite a draft a person touched). Everyone who is not 'invited' today was activated at some point.
ALTER TABLE users ADD COLUMN activated_at INTEGER;
UPDATE users SET activated_at = created_at WHERE status <> 'invited';
