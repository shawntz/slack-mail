CREATE TABLE IF NOT EXISTS workspaces (
  id SERIAL PRIMARY KEY,
  slack_team_id TEXT NOT NULL UNIQUE,
  team_name TEXT,
  bot_token_encrypted TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slack_user_gmail_accounts (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  google_email TEXT,
  refresh_token_encrypted TEXT NOT NULL,
  history_id TEXT,
  watch_expiration TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_gmail_google_email ON slack_user_gmail_accounts (google_email);

CREATE TABLE IF NOT EXISTS gmail_thread_slack_channels (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  subject TEXT,
  last_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, slack_user_id, gmail_thread_id),
  UNIQUE (slack_channel_id)
);

CREATE TABLE IF NOT EXISTS gmail_message_slack_posts (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  slack_ts TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (gmail_message_id)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  id SERIAL PRIMARY KEY,
  state_token TEXT NOT NULL UNIQUE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states (expires_at);
