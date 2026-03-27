CREATE TABLE IF NOT EXISTS gmail_category_channels (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, slack_user_id, category)
);

CREATE TABLE IF NOT EXISTS gmail_thread_slack_threads (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts TEXT NOT NULL,
  subject TEXT,
  last_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, slack_user_id, gmail_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_thread_slack_threads_channel_ts
  ON gmail_thread_slack_threads (slack_channel_id, slack_thread_ts);
