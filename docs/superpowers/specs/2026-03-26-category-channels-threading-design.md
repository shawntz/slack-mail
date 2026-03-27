# Category Channels with Slack Threading

**Date:** 2026-03-26
**Status:** Approved

## Summary

Replace the current one-Slack-channel-per-Gmail-thread architecture with category-based channels that use Slack's native threading to group email conversations. Emails are routed to private channels based on Gmail's built-in categories (Primary, Social, Promotions, Updates, Forums). Each email thread becomes a Slack thread within the appropriate category channel. Replying in a Slack thread sends a Gmail reply; incoming email replies appear as threaded replies.

## Motivation

The current model creates a new private Slack channel for every Gmail thread. This leads to channel sprawl — dozens or hundreds of channels that each contain only a few messages. Category-based channels with threading provide a cleaner organization model where related emails are grouped by type and conversations are contained within Slack threads.

## Design Decisions

- **Gmail's built-in categories** determine routing (Primary, Social, Promotions, Updates, Forums)
- **Lazy channel creation** — category channels are created on-demand when the first email of that category arrives, not all 5 upfront
- **Private channels** — maintains current privacy model (only the linked user + bot)
- **Channel naming** — `mail-{category}` with a `Date.now().toString(36)` suffix appended only on collision (matches existing pattern)
- **Reply confirmation** — checkmark emoji reaction on the user's Slack message (not a new message); errors still posted as threaded replies (existing pattern)
- **Clean break migration** — old per-thread channels remain as-is; new emails use the new system
- **Thread-level category routing** — all messages in a Gmail thread route to the category of the *first* message, even if Gmail later reclassifies individual messages. This prevents conversations from being split across channels.
- **Emails without category labels** (e.g., filtered emails, or users with Gmail categories disabled) default to `primary`

## Data Model

### New Table: `gmail_category_channels`

Maps a user's Gmail category to a Slack channel.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | `SERIAL` | PRIMARY KEY |
| `workspace_id` | `INT` | NOT NULL, FK to workspaces |
| `slack_user_id` | `TEXT` | NOT NULL |
| `category` | `TEXT` | NOT NULL, one of: primary, social, promotions, updates, forums |
| `slack_channel_id` | `TEXT` | NOT NULL, UNIQUE |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT NOW() |

**Unique constraint:** `(workspace_id, slack_user_id, category)`

### New Table: `gmail_thread_slack_threads`

Maps a Gmail thread to a Slack thread (message `ts`) within a category channel.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | `SERIAL` | PRIMARY KEY |
| `workspace_id` | `INT` | NOT NULL, FK to workspaces |
| `slack_user_id` | `TEXT` | NOT NULL |
| `gmail_thread_id` | `TEXT` | NOT NULL |
| `slack_channel_id` | `TEXT` | NOT NULL |
| `slack_thread_ts` | `TEXT` | NOT NULL |
| `subject` | `TEXT` | (nullable, matches existing pattern) |
| `last_message_id` | `TEXT` | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT NOW() |

**Unique constraint:** `(workspace_id, slack_user_id, gmail_thread_id)`

**Index:** `(slack_channel_id, slack_thread_ts)` — used by the reply handler on every incoming Slack message

### Retained Tables (unchanged)

- `gmail_message_slack_posts` — deduplication, no changes
- `gmail_thread_slack_channels` — kept for backward compatibility with existing channels, no longer written to

## Email Ingestion Flow

When a new email arrives via Pub/Sub:

1. **Fetch message** via Gmail API (unchanged)
2. **Determine category** from `labelIds`:
   - `CATEGORY_SOCIAL` -> `social`
   - `CATEGORY_PROMOTIONS` -> `promotions`
   - `CATEGORY_UPDATES` -> `updates`
   - `CATEGORY_FORUMS` -> `forums`
   - Default -> `primary`
3. **Get or create category channel:**
   - Query `gmail_category_channels` for `(workspace_id, slack_user_id, category)`
   - If not found: create private channel `mail-{category}` (append `Date.now().toString(36)` suffix on naming collision), invite user, insert row with `ON CONFLICT DO NOTHING` + fallback SELECT for race safety
4. **Get or create thread mapping:**
   - Query `gmail_thread_slack_threads` for `(workspace_id, slack_user_id, gmail_thread_id)`
   - **New thread:** Post parent message to category channel (same format as current: From, Subject, Message-ID, body). Store returned `ts` as `slack_thread_ts` with `ON CONFLICT` race safety. For existing threads with messages in different categories, use the category channel from the existing mapping (not the new message's category).
   - **Existing thread:** Use stored `slack_thread_ts` to post as a threaded reply.
5. **Post message** with `thread_ts` set (for follow-ups) or as a new message (for thread roots)
6. **Deduplicate** via `gmail_message_slack_posts` claim (unchanged)

## Reply Handling

### Slack -> Gmail

1. Bot receives message in a category channel
2. Verify message is a threaded reply (`thread_ts` differs from `ts`)
3. Look up `gmail_thread_slack_threads` by `(slack_channel_id, slack_thread_ts)` to find Gmail thread
4. Ignore top-level (non-threaded) messages — not a reply to any email
5. Send reply via `sendGmailReplyFromSlack()` (existing logic, lookup adjusted to use new table)
6. React with `:white_check_mark:` on the user's message

### Gmail -> Slack

No special logic needed. Incoming replies are part of an existing Gmail thread. The ingestion flow (step 4) finds the existing `slack_thread_ts` and posts as a threaded reply automatically.

### Edge Cases

- Bot's own synced messages won't trigger reply handler (existing `bot_id` / `botUserId` checks in message handler)
- Top-level messages in category channels are ignored by the reply handler
- Race condition on category channel creation: use `INSERT ... ON CONFLICT DO NOTHING` + fallback SELECT (matches existing `insertThreadChannelOrGet` pattern)
- Race condition on thread mapping creation: same `ON CONFLICT` pattern

## Files to Modify

| File | Change |
|------|--------|
| `src/db/migrations/` | New migration for `gmail_category_channels` and `gmail_thread_slack_threads` tables |
| `src/db/repos.ts` | New DB functions: `getOrCreateCategoryChannel`, `getOrCreateThreadMapping`, `getThreadMappingBySlackThread`, `updateThreadSlackLastMessageId` (targets new table) |
| `src/gmail/sync.ts` | Replace channel-per-thread with category-channel + threading logic |
| `src/gmail/sendReply.ts` | Update to look up thread via `gmail_thread_slack_threads` instead of `gmail_thread_slack_channels` |
| `src/slack/boltApp.ts` | Update message handler to require threaded replies; add reaction confirmation |

## Migration Strategy

- **Database:** Add new tables alongside existing ones. No data migration.
- **Old channels:** Remain in Slack. Bot stops creating new per-thread channels. Existing channels continue to function (old message handler can be removed or left as dead code).
- **New emails:** Route to category channels with threading from the moment the new code deploys.
