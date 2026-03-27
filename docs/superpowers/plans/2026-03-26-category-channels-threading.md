# Category Channels with Slack Threading — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-thread Slack channels with Gmail-category-based channels that use Slack threading for email conversations.

**Architecture:** New DB tables (`gmail_category_channels`, `gmail_thread_slack_threads`) sit alongside existing tables. `sync.ts` maps Gmail labels to categories, lazily creates category channels, and posts emails as Slack threads. `boltApp.ts` reply handler requires threaded replies and reacts with a checkmark.

**Tech Stack:** TypeScript, PostgreSQL, Slack Bolt, Gmail API, Slack Web API

**Spec:** `docs/superpowers/specs/2026-03-26-category-channels-threading-design.md`

---

## Chunk 1: Database Layer

### Task 1: Add migration for new tables

**Files:**
- Create: `src/db/migrations/002_category_channels.sql`
- Modify: `src/db/runMigrations.ts:8-13`

- [ ] **Step 1: Write the migration SQL**

Create `src/db/migrations/002_category_channels.sql`:

```sql
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
```

- [ ] **Step 2: Update migration runner to execute both files**

Modify `src/db/runMigrations.ts` — the current runner only loads `001_initial.sql`. Update it to run all migration files in order:

```typescript
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  const migrationsDir = join(__dirname, "migrations");
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    await pool.query(sql);
  }
}
```

- [ ] **Step 3: Verify migration compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/002_category_channels.sql src/db/runMigrations.ts
git commit -m "feat: add migration for category channels and thread mapping tables"
```

---

### Task 2: Add new DB repository functions

**Files:**
- Modify: `src/db/repos.ts` (add functions after line 246)

- [ ] **Step 1: Add the `GmailCategory` type and `getCategoryChannel` function**

Add to `src/db/repos.ts` after the existing `updateThreadLastMessageId` function (after line 246):

```typescript
export type GmailCategory = "primary" | "social" | "promotions" | "updates" | "forums";

export async function getCategoryChannel(
  workspaceId: number,
  slackUserId: string,
  category: GmailCategory,
): Promise<{ slack_channel_id: string } | null> {
  const pool = getPool();
  const r = await pool.query<{ slack_channel_id: string }>(
    `SELECT slack_channel_id FROM gmail_category_channels
     WHERE workspace_id = $1 AND slack_user_id = $2 AND category = $3`,
    [workspaceId, slackUserId, category],
  );
  return r.rows[0] ?? null;
}
```

- [ ] **Step 2: Add `insertCategoryChannelOrGet` function**

```typescript
export async function insertCategoryChannelOrGet(params: {
  workspaceId: number;
  slackUserId: string;
  category: GmailCategory;
  slackChannelId: string;
}): Promise<string> {
  const pool = getPool();
  const ins = await pool.query<{ slack_channel_id: string }>(
    `INSERT INTO gmail_category_channels
      (workspace_id, slack_user_id, category, slack_channel_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, slack_user_id, category) DO NOTHING
     RETURNING slack_channel_id`,
    [params.workspaceId, params.slackUserId, params.category, params.slackChannelId],
  );
  if (ins.rows[0]) return ins.rows[0].slack_channel_id;
  const existing = await getCategoryChannel(
    params.workspaceId,
    params.slackUserId,
    params.category,
  );
  if (!existing) throw new Error("Category channel missing after insert race");
  return existing.slack_channel_id;
}
```

- [ ] **Step 3: Add `getThreadSlackThread` function**

```typescript
export async function getThreadSlackThread(
  workspaceId: number,
  slackUserId: string,
  gmailThreadId: string,
): Promise<{ slack_channel_id: string; slack_thread_ts: string; last_message_id: string | null } | null> {
  const pool = getPool();
  const r = await pool.query<{ slack_channel_id: string; slack_thread_ts: string; last_message_id: string | null }>(
    `SELECT slack_channel_id, slack_thread_ts, last_message_id FROM gmail_thread_slack_threads
     WHERE workspace_id = $1 AND slack_user_id = $2 AND gmail_thread_id = $3`,
    [workspaceId, slackUserId, gmailThreadId],
  );
  return r.rows[0] ?? null;
}
```

- [ ] **Step 4: Add `insertThreadSlackThreadOrGet` function**

```typescript
export async function insertThreadSlackThreadOrGet(params: {
  workspaceId: number;
  slackUserId: string;
  gmailThreadId: string;
  slackChannelId: string;
  slackThreadTs: string;
  subject: string | null;
  lastMessageId: string | null;
}): Promise<{ slack_channel_id: string; slack_thread_ts: string }> {
  const pool = getPool();
  const ins = await pool.query<{ slack_channel_id: string; slack_thread_ts: string }>(
    `INSERT INTO gmail_thread_slack_threads
      (workspace_id, slack_user_id, gmail_thread_id, slack_channel_id, slack_thread_ts, subject, last_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, slack_user_id, gmail_thread_id) DO NOTHING
     RETURNING slack_channel_id, slack_thread_ts`,
    [
      params.workspaceId,
      params.slackUserId,
      params.gmailThreadId,
      params.slackChannelId,
      params.slackThreadTs,
      params.subject,
      params.lastMessageId,
    ],
  );
  if (ins.rows[0]) return ins.rows[0];
  const existing = await getThreadSlackThread(
    params.workspaceId,
    params.slackUserId,
    params.gmailThreadId,
  );
  if (!existing) throw new Error("Thread mapping missing after insert race");
  return { slack_channel_id: existing.slack_channel_id, slack_thread_ts: existing.slack_thread_ts };
}
```

- [ ] **Step 5: Add `getThreadMappingBySlackThread` function**

```typescript
export async function getThreadMappingBySlackThread(
  slackChannelId: string,
  slackThreadTs: string,
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
     FROM gmail_thread_slack_threads WHERE slack_channel_id = $1 AND slack_thread_ts = $2`,
    [slackChannelId, slackThreadTs],
  );
  return r.rows[0] ?? null;
}
```

- [ ] **Step 6: Add `updateThreadSlackLastMessageId` function**

```typescript
export async function updateThreadSlackLastMessageId(
  workspaceId: number,
  slackUserId: string,
  gmailThreadId: string,
  lastMessageId: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE gmail_thread_slack_threads SET last_message_id = $4
     WHERE workspace_id = $1 AND slack_user_id = $2 AND gmail_thread_id = $3`,
    [workspaceId, slackUserId, gmailThreadId, lastMessageId],
  );
}
```

- [ ] **Step 7: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/db/repos.ts
git commit -m "feat: add repository functions for category channels and thread mappings"
```

---

## Chunk 2: Email Ingestion (sync.ts)

### Task 3: Rewrite sync.ts for category-based channel routing with threading

**Files:**
- Modify: `src/gmail/sync.ts`

The main changes:
1. Replace `ensureThreadSlackChannel` (which creates a channel per thread) with `ensureCategoryChannel` (which creates a channel per Gmail category)
2. Replace `channelBaseName` and `getThreadFirstMessageSummary` with `categoryChannelName` (simpler — just `mail-{category}`)
3. In `ingestOneMessage`, determine category from labels, get/create category channel, get/create thread mapping, post with `thread_ts`

- [ ] **Step 1: Add `labelToCategory` helper**

Add after the existing `emailFromHeader` function (after line 54 in current `sync.ts`):

```typescript
import type { GmailCategory } from "../db/repos.js";

function labelToCategory(labelIds: string[]): GmailCategory {
  if (labelIds.includes("CATEGORY_SOCIAL")) return "social";
  if (labelIds.includes("CATEGORY_PROMOTIONS")) return "promotions";
  if (labelIds.includes("CATEGORY_UPDATES")) return "updates";
  if (labelIds.includes("CATEGORY_FORUMS")) return "forums";
  return "primary";
}
```

- [ ] **Step 2: Remove old functions and replace with category-channel equivalents**

Remove these functions (keep `emailFromHeader` at lines 51-54 and `LinkedGmailAccount` type at line 23 — they are still used):
- `slackChannelSlug` (lines 25-32)
- `channelBaseName` (lines 34-49)
- `createPrivateMailChannel` (lines 56-72)
- `ensureThreadSlackChannel` (lines 74-116)
- `getThreadFirstMessageSummary` (lines 118-142)

Also remove the `import type { gmail_v1 } from "googleapis";` (line 6) — no longer used after removing `ensureThreadSlackChannel`.

Replace the removed functions with:

```typescript
async function createPrivateChannel(web: WebClient, baseName: string): Promise<string> {
  const tryName = async (name: string): Promise<string> => {
    const res = await web.conversations.create({ name, is_private: true });
    const id = res.channel?.id;
    if (!id) throw new Error("conversations.create missing channel id");
    return id;
  };
  try {
    return await tryName(baseName);
  } catch (e: unknown) {
    const err = e as { data?: { error?: string } };
    if (err.data?.error === "name_taken") {
      return await tryName(`${baseName}-${Date.now().toString(36)}`);
    }
    throw e;
  }
}

async function ensureCategoryChannel(params: {
  web: WebClient;
  workspaceId: number;
  slackUserId: string;
  category: GmailCategory;
}): Promise<string> {
  const existing = await getCategoryChannel(
    params.workspaceId,
    params.slackUserId,
    params.category,
  );
  if (existing) return existing.slack_channel_id;

  const baseName = `mail-${params.category}`;
  const channelId = await createPrivateChannel(params.web, baseName);

  await params.web.conversations.invite({
    channel: channelId,
    users: params.slackUserId,
  });

  return insertCategoryChannelOrGet({
    workspaceId: params.workspaceId,
    slackUserId: params.slackUserId,
    category: params.category,
    slackChannelId: channelId,
  });
}
```

- [ ] **Step 3: Update imports in sync.ts**

Replace the imports from `../db/repos.js` with:

```typescript
import {
  claimGmailMessagePost,
  decryptBotToken,
  decryptGoogleRefreshToken,
  finalizeGmailMessageSlackTs,
  getCategoryChannel,
  getThreadSlackThread,
  getWorkspaceBySlackTeamId,
  insertCategoryChannelOrGet,
  insertThreadSlackThreadOrGet,
  releaseGmailMessageClaim,
  updateGmailHistoryId,
  updateThreadSlackLastMessageId,
} from "../db/repos.js";
import type { GmailCategory, SlackUserGmailRow } from "../db/repos.js";
```

Remove the `createHash` import from `node:crypto` (no longer needed for channel naming).

- [ ] **Step 4: Rewrite `ingestOneMessage` to use category channels and threading**

Replace the entire `ingestOneMessage` function (lines 144-231) with:

```typescript
async function ingestOneMessage(params: {
  account: LinkedGmailAccount;
  workspaceId: number;
  web: WebClient;
  messageId: string;
}): Promise<void> {
  const gmail = createGmailForRefresh(decryptGoogleRefreshToken(params.account));
  const msg = await gmail.users.messages.get({
    userId: "me",
    id: params.messageId,
    format: "full",
  });
  const labels = msg.data.labelIds ?? [];
  if (!labels.includes("INBOX")) return;
  if (labels.includes("SENT")) return;

  const threadId = msg.data.threadId;
  if (!threadId) return;

  const headers = msg.data.payload?.headers;
  const subject = getHeader(headers, "Subject") || "(no subject)";
  const from = getHeader(headers, "From") || "(unknown)";
  const linked = (params.account.google_email ?? "").trim().toLowerCase();
  if (linked && emailFromHeader(from) === linked) return;
  const rfcId = getHeader(headers, "Message-ID") || params.messageId;
  const body = extractPlainText(msg.data.payload) || msg.data.snippet || "";

  // Check if this thread already has a mapping (use its existing channel regardless of current label category)
  const existingThread = await getThreadSlackThread(
    params.workspaceId,
    params.account.slack_user_id,
    threadId,
  );

  let channelId: string;
  let threadTs: string | undefined;

  if (existingThread) {
    // Existing thread — post as a threaded reply in the same category channel
    channelId = existingThread.slack_channel_id;
    threadTs = existingThread.slack_thread_ts;
  } else {
    // New thread — determine category, ensure channel, post root message
    const category = labelToCategory(labels);
    channelId = await ensureCategoryChannel({
      web: params.web,
      workspaceId: params.workspaceId,
      slackUserId: params.account.slack_user_id,
      category,
    });
  }

  const claimed = await claimGmailMessagePost({
    workspaceId: params.workspaceId,
    gmailMessageId: params.messageId,
    slackChannelId: channelId,
  });
  if (!claimed) return;

  const fromLine = formatFromForSlack(from);
  const text = `*From:* ${fromLine}\n*Subject:* ${subject}\n*Message-ID:* \`${rfcId}\`\n\n${body}`;
  let postTs: string | undefined;
  try {
    const post = await params.web.chat.postMessage({
      channel: channelId,
      text,
      mrkdwn: true,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    postTs = post.ts;
    if (postTs) {
      await finalizeGmailMessageSlackTs(params.messageId, postTs);
    }
  } catch (e) {
    await releaseGmailMessageClaim(params.messageId);
    throw e;
  }

  // For new threads, store the thread mapping using the root message ts
  if (!existingThread && postTs) {
    await insertThreadSlackThreadOrGet({
      workspaceId: params.workspaceId,
      slackUserId: params.account.slack_user_id,
      gmailThreadId: threadId,
      slackChannelId: channelId,
      slackThreadTs: postTs,
      subject,
      lastMessageId: rfcId,
    });
  }

  // Mark as read
  if (labels.includes("UNREAD")) {
    try {
      await gmail.users.messages.modify({
        userId: "me",
        id: params.messageId,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
    } catch (e) {
      console.error("Failed to mark Gmail message as read", params.messageId, e);
    }
  }

  await updateThreadSlackLastMessageId(
    params.workspaceId,
    params.account.slack_user_id,
    threadId,
    rfcId,
  );
}
```

- [ ] **Step 5: Update `processGmailAccountInboxDelta`**

Two changes in this function:

1. Remove the unused `gmail` variable (line 239: `const gmail = createGmailForRefresh(...)`) — it was only passed to the old `ensureThreadSlackChannel`, and each `ingestOneMessage` call creates its own gmail client internally.

2. Simplify the `ingestOneMessage` call (around line 268) — remove `firstMessageDateMs` since we removed it from the signature:

```typescript
await ingestOneMessage({
  account,
  workspaceId: account.workspace_id,
  web,
  messageId: mid,
});
```

- [ ] **Step 6: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/gmail/sync.ts
git commit -m "feat: route emails to category channels with Slack threading"
```

---

## Chunk 3: Reply Handler (boltApp.ts)

### Task 4: Update Slack message handler for threaded replies with reaction confirmation

**Files:**
- Modify: `src/slack/boltApp.ts`

- [ ] **Step 1: Update imports**

Replace `getThreadMappingBySlackChannel` with `getThreadMappingBySlackThread` in the imports (line 4):

```typescript
import {
  getSlackUserGmailByWorkspaceAndUser,
  getThreadMappingBySlackThread,
  getWorkspaceById,
  getWorkspaceBySlackTeamId,
} from "../db/repos.js";
```

- [ ] **Step 2: Rewrite the `app.message` handler**

Replace the entire `app.message(...)` handler (lines 30-63) with:

```typescript
  app.message(async ({ message, context, client, logger }) => {
    if ("subtype" in message && message.subtype) return;
    if (!("user" in message) || !message.user) return;
    if ("bot_id" in message && message.bot_id) return;
    if (message.user === context.botUserId) return;
    if (!("channel" in message) || typeof message.channel !== "string") return;
    if (!("text" in message) || typeof message.text !== "string" || !message.text.trim()) return;

    // Only handle threaded replies — ignore top-level messages in category channels
    if (!("thread_ts" in message) || !message.thread_ts) return;
    if (message.thread_ts === message.ts) return;

    const mapping = await getThreadMappingBySlackThread(message.channel, message.thread_ts);
    if (!mapping) return;
    if (mapping.slack_user_id !== message.user) return;

    const ws = await getWorkspaceById(mapping.workspace_id);
    if (!ws) return;

    const acct = await getSlackUserGmailByWorkspaceAndUser(ws.id, message.user);
    if (!acct?.google_email) return;

    try {
      await sendGmailReplyFromSlack({
        account: acct,
        gmailThreadId: mapping.gmail_thread_id,
        userEmail: acct.google_email,
        bodyText: message.text,
      });
      await client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: "white_check_mark",
      });
    } catch (e) {
      logger.error(e);
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.thread_ts,
        text: `Could not send email: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/slack/boltApp.ts
git commit -m "feat: require threaded replies for email sending, add checkmark reaction"
```

---

## Chunk 4: Final Verification

### Task 5: End-to-end compilation and cleanup

**Files:**
- All modified files

- [ ] **Step 1: Full TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2: Verify no stale imports of removed functions**

Run: `grep -r "getThreadChannelMapping\|insertThreadChannelOrGet\|updateThreadLastMessageId\|getThreadMappingBySlackChannel\|channelBaseName\|ensureThreadSlackChannel\|getThreadFirstMessageSummary" src/ --include="*.ts" | grep -v "repos.ts"`
Expected: no matches outside of `repos.ts` (old functions are intentionally retained in `repos.ts` for backward compatibility with existing channels, but should not be imported or referenced elsewhere)

**Note:** `sendReply.ts` was listed in the spec's "Files to Modify" but requires no changes — it receives `gmailThreadId` as a parameter and doesn't query any mapping table directly.

- [ ] **Step 3: Commit any cleanup**

If any stale references found, fix and commit:

```bash
git add -A
git commit -m "chore: remove stale references to old per-thread channel functions"
```
