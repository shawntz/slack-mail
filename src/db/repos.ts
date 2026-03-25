import { getConfig } from "../config.js";
import { encryptSecret, decryptSecret } from "../crypto/secretBox.js";
import { getPool } from "./pool.js";

export type WorkspaceRow = {
  id: number;
  slack_team_id: string;
  team_name: string | null;
  bot_token_encrypted: string;
  bot_user_id: string;
};

export type SlackUserGmailRow = {
  id: number;
  workspace_id: number;
  slack_user_id: string;
  google_email: string | null;
  refresh_token_encrypted: string;
  history_id: string | null;
  watch_expiration: Date | null;
};

function enc(t: string): string {
  return encryptSecret(t, getConfig().TOKEN_ENCRYPTION_KEY);
}

function dec(t: string): string {
  return decryptSecret(t, getConfig().TOKEN_ENCRYPTION_KEY);
}

export async function upsertWorkspace(params: {
  slackTeamId: string;
  teamName: string | null;
  botToken: string;
  botUserId: string;
}): Promise<WorkspaceRow> {
  const pool = getPool();
  const botTok = enc(params.botToken);
  const r = await pool.query<WorkspaceRow>(
    `INSERT INTO workspaces (slack_team_id, team_name, bot_token_encrypted, bot_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (slack_team_id) DO UPDATE SET
       team_name = EXCLUDED.team_name,
       bot_token_encrypted = EXCLUDED.bot_token_encrypted,
       bot_user_id = EXCLUDED.bot_user_id,
       updated_at = NOW()
     RETURNING *`,
    [params.slackTeamId, params.teamName, botTok, params.botUserId],
  );
  return r.rows[0]!;
}

export async function getWorkspaceBySlackTeamId(slackTeamId: string): Promise<WorkspaceRow | null> {
  const pool = getPool();
  const r = await pool.query<WorkspaceRow>(
    `SELECT * FROM workspaces WHERE slack_team_id = $1`,
    [slackTeamId],
  );
  return r.rows[0] ?? null;
}

export async function getWorkspaceById(id: number): Promise<WorkspaceRow | null> {
  const pool = getPool();
  const r = await pool.query<WorkspaceRow>(`SELECT * FROM workspaces WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export function decryptBotToken(row: WorkspaceRow): string {
  return dec(row.bot_token_encrypted);
}

export async function upsertSlackUserGmail(params: {
  workspaceId: number;
  slackUserId: string;
  googleEmail: string;
  refreshToken: string;
  historyId: string | null;
}): Promise<SlackUserGmailRow> {
  const pool = getPool();
  const rt = enc(params.refreshToken);
  const r = await pool.query<SlackUserGmailRow>(
    `INSERT INTO slack_user_gmail_accounts
      (workspace_id, slack_user_id, google_email, refresh_token_encrypted, history_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, slack_user_id) DO UPDATE SET
       google_email = EXCLUDED.google_email,
       refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       history_id = COALESCE(EXCLUDED.history_id, slack_user_gmail_accounts.history_id),
       updated_at = NOW()
     RETURNING *`,
    [params.workspaceId, params.slackUserId, params.googleEmail, rt, params.historyId],
  );
  return r.rows[0]!;
}

export async function getSlackUserGmailByWorkspaceAndUser(
  workspaceId: number,
  slackUserId: string,
): Promise<SlackUserGmailRow | null> {
  const pool = getPool();
  const r = await pool.query<SlackUserGmailRow>(
    `SELECT * FROM slack_user_gmail_accounts WHERE workspace_id = $1 AND slack_user_id = $2`,
    [workspaceId, slackUserId],
  );
  return r.rows[0] ?? null;
}

export async function getSlackUserGmailByGoogleEmail(email: string): Promise<
  | (SlackUserGmailRow & { slack_team_id: string })
  | null
> {
  const pool = getPool();
  const r = await pool.query<SlackUserGmailRow & { slack_team_id: string }>(
    `SELECT a.*, w.slack_team_id
     FROM slack_user_gmail_accounts a
     JOIN workspaces w ON w.id = a.workspace_id
     WHERE a.google_email = $1`,
    [email],
  );
  return r.rows[0] ?? null;
}

export function decryptGoogleRefreshToken(row: SlackUserGmailRow): string {
  return dec(row.refresh_token_encrypted);
}

export async function updateGmailHistoryId(
  accountId: number,
  historyId: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE slack_user_gmail_accounts SET history_id = $2, updated_at = NOW() WHERE id = $1`,
    [accountId, historyId],
  );
}

export async function updateWatchExpiration(accountId: number, expiration: Date | null): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE slack_user_gmail_accounts SET watch_expiration = $2, updated_at = NOW() WHERE id = $1`,
    [accountId, expiration],
  );
}

export async function listGmailAccountsNeedingWatchRenewal(withinMs: number): Promise<SlackUserGmailRow[]> {
  const pool = getPool();
  const threshold = new Date(Date.now() + withinMs);
  const r = await pool.query<SlackUserGmailRow>(
    `SELECT * FROM slack_user_gmail_accounts
     WHERE watch_expiration IS NOT NULL AND watch_expiration < $1`,
    [threshold],
  );
  return r.rows;
}

export async function listAllLinkedGmailAccounts(): Promise<SlackUserGmailRow[]> {
  const pool = getPool();
  const r = await pool.query<SlackUserGmailRow>(`SELECT * FROM slack_user_gmail_accounts`);
  return r.rows;
}

export async function getThreadChannelMapping(
  workspaceId: number,
  slackUserId: string,
  gmailThreadId: string,
): Promise<{ slack_channel_id: string; last_message_id: string | null } | null> {
  const pool = getPool();
  const r = await pool.query<{ slack_channel_id: string; last_message_id: string | null }>(
    `SELECT slack_channel_id, last_message_id FROM gmail_thread_slack_channels
     WHERE workspace_id = $1 AND slack_user_id = $2 AND gmail_thread_id = $3`,
    [workspaceId, slackUserId, gmailThreadId],
  );
  return r.rows[0] ?? null;
}

export async function getThreadMappingBySlackChannel(
  slackChannelId: string,
): Promise<{
  workspace_id: number;
  slack_user_id: string;
  gmail_thread_id: string;
  last_message_id: string | null;
} | null> {
  const pool = getPool();
  const r = await pool.query<{
    workspace_id: number;
    slack_user_id: string;
    gmail_thread_id: string;
    last_message_id: string | null;
  }>(
    `SELECT workspace_id, slack_user_id, gmail_thread_id, last_message_id
     FROM gmail_thread_slack_channels WHERE slack_channel_id = $1`,
    [slackChannelId],
  );
  return r.rows[0] ?? null;
}

/** Inserts mapping or returns existing channel id for this thread (handles races). */
export async function insertThreadChannelOrGet(params: {
  workspaceId: number;
  slackUserId: string;
  gmailThreadId: string;
  slackChannelId: string;
  subject: string | null;
  lastMessageId: string | null;
}): Promise<string> {
  const pool = getPool();
  const ins = await pool.query<{ slack_channel_id: string }>(
    `INSERT INTO gmail_thread_slack_channels
      (workspace_id, slack_user_id, gmail_thread_id, slack_channel_id, subject, last_message_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, slack_user_id, gmail_thread_id) DO NOTHING
     RETURNING slack_channel_id`,
    [
      params.workspaceId,
      params.slackUserId,
      params.gmailThreadId,
      params.slackChannelId,
      params.subject,
      params.lastMessageId,
    ],
  );
  if (ins.rows[0]) return ins.rows[0].slack_channel_id;
  const existing = await getThreadChannelMapping(
    params.workspaceId,
    params.slackUserId,
    params.gmailThreadId,
  );
  if (!existing) throw new Error("Thread mapping missing after insert race");
  return existing.slack_channel_id;
}

export async function updateThreadLastMessageId(
  workspaceId: number,
  slackUserId: string,
  gmailThreadId: string,
  lastMessageId: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE gmail_thread_slack_channels SET last_message_id = $4
     WHERE workspace_id = $1 AND slack_user_id = $2 AND gmail_thread_id = $3`,
    [workspaceId, slackUserId, gmailThreadId, lastMessageId],
  );
}

/** Returns true if this worker claimed the message (should post); false if already synced. */
export async function claimGmailMessagePost(params: {
  workspaceId: number;
  gmailMessageId: string;
  slackChannelId: string;
}): Promise<boolean> {
  const pool = getPool();
  const r = await pool.query(
    `INSERT INTO gmail_message_slack_posts (workspace_id, gmail_message_id, slack_channel_id, slack_ts)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (gmail_message_id) DO NOTHING
     RETURNING id`,
    [params.workspaceId, params.gmailMessageId, params.slackChannelId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function finalizeGmailMessageSlackTs(gmailMessageId: string, slackTs: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE gmail_message_slack_posts SET slack_ts = $2 WHERE gmail_message_id = $1`,
    [gmailMessageId, slackTs],
  );
}

export async function releaseGmailMessageClaim(gmailMessageId: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM gmail_message_slack_posts WHERE gmail_message_id = $1 AND slack_ts = 'pending'`, [
    gmailMessageId,
  ]);
}

export async function createOAuthState(params: {
  stateToken: string;
  workspaceId: number;
  slackUserId: string;
  ttlSeconds: number;
}): Promise<void> {
  const pool = getPool();
  const expires = new Date(Date.now() + params.ttlSeconds * 1000);
  await pool.query(
    `INSERT INTO oauth_states (state_token, workspace_id, slack_user_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [params.stateToken, params.workspaceId, params.slackUserId, expires],
  );
}

export async function consumeOAuthState(
  stateToken: string,
): Promise<{ workspaceId: number; slackUserId: string } | null> {
  const pool = getPool();
  const r = await pool.query<{ workspace_id: number; slack_user_id: string }>(
    `DELETE FROM oauth_states WHERE state_token = $1 AND expires_at > NOW()
     RETURNING workspace_id, slack_user_id`,
    [stateToken],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { workspaceId: row.workspace_id, slackUserId: row.slack_user_id };
}

export async function deleteExpiredOAuthStates(): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM oauth_states WHERE expires_at < NOW()`);
}
