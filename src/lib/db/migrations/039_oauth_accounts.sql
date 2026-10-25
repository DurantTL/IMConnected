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
