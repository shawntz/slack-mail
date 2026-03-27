# Compose New Email — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/compose` slash command that opens a Slack modal to compose and send new emails, with sent messages posted as threads in the category channel for reply tracking.

**Architecture:** New `/compose` command + `view_submission` handler in `boltApp.ts`. New `sendNew.ts` file for composing fresh emails (no reply headers). `ensureCategoryChannel` exported from `sync.ts` for reuse. After sending, the bot posts the email as a thread in `mail-primary` and stores the Gmail thread mapping.

**Tech Stack:** TypeScript, Slack Bolt (commands, views), Gmail API, Slack Web API

**Spec:** `docs/superpowers/specs/2026-03-27-compose-email-design.md`

---

## Chunk 1: Email Sending Function

### Task 1: Create `sendNew.ts` for composing new emails

**Files:**
- Create: `src/gmail/sendNew.ts`

- [ ] **Step 1: Create the file with the full implementation**

Create `src/gmail/sendNew.ts`:

```typescript
import { createGmailForRefresh } from "./client.js";
import { decryptGoogleRefreshToken } from "../db/repos.js";
import type { SlackUserGmailRow } from "../db/repos.js";

function encodeRawRfc2822(lines: string[]): string {
  const raw = lines.join("\r\n");
  return Buffer.from(raw, "utf8").toString("base64url");
}

export async function sendNewEmail(params: {
  account: SlackUserGmailRow;
  userEmail: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  bodyText: string;
}): Promise<{ messageId: string; threadId: string }> {
  const gmail = createGmailForRefresh(decryptGoogleRefreshToken(params.account));

  // Fetch display name from Gmail send-as settings
  let fromHeader = params.userEmail;
  try {
    const sendAs = await gmail.users.settings.sendAs.list({ userId: "me" });
    const primary = sendAs.data.sendAs?.find((s) => s.isPrimary);
    if (primary?.displayName) {
      fromHeader = `"${primary.displayName}" <${params.userEmail}>`;
    }
  } catch {
    // Fall back to bare email
  }

  const headers = [
    `From: ${fromHeader}`,
    `To: ${params.to}`,
  ];
  if (params.cc) headers.push(`Cc: ${params.cc}`);
  if (params.bcc) headers.push(`Bcc: ${params.bcc}`);
  headers.push(
    `Subject: ${params.subject}`,
    "Content-Type: text/plain; charset=utf-8",
  );

  const rawLines = [...headers, "", params.bodyText];
  const raw = encodeRawRfc2822(rawLines);

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  const messageId = res.data.id;
  const threadId = res.data.threadId;
  if (!messageId || !threadId) {
    throw new Error("Gmail send response missing id or threadId");
  }

  return { messageId, threadId };
}
```

Key differences from `sendReply.ts`:
- No `threadId` in the send request (new conversation)
- No `In-Reply-To` or `References` headers
- Supports To, CC, BCC headers
- Returns `messageId` and `threadId` from the response for thread mapping

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/gmail/sendNew.ts
git commit -m "feat: add sendNewEmail function for composing fresh emails

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 2: Export `ensureCategoryChannel`

### Task 2: Export `ensureCategoryChannel` from sync.ts

**Files:**
- Modify: `src/gmail/sync.ts:56`

- [ ] **Step 1: Add `export` keyword to `ensureCategoryChannel`**

In `src/gmail/sync.ts`, change line 56 from:

```typescript
async function ensureCategoryChannel(params: {
```

to:

```typescript
export async function ensureCategoryChannel(params: {
```

That's the only change — add `export` to the existing function.

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/gmail/sync.ts
git commit -m "feat: export ensureCategoryChannel for reuse by compose handler

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 3: Slash Command & Modal

### Task 3: Add `/compose` command and modal submission handler to boltApp.ts

**Files:**
- Modify: `src/slack/boltApp.ts`

- [ ] **Step 1: Add new imports**

Add these imports to the top of `src/slack/boltApp.ts`. Update the repos import (lines 2-8) and add new imports:

```typescript
import type { App } from "@slack/bolt";
import slackWebApi from "@slack/web-api";
const { WebClient: WebClientCtor } = slackWebApi;
import {
  decryptBotToken,
  getSlackUserGmailByWorkspaceAndUser,
  getThreadMappingBySlackThread,
  getWorkspaceById,
  getWorkspaceBySlackTeamId,
  insertThreadSlackThreadOrGet,
} from "../db/repos.js";
import { sendGmailReplyFromSlack } from "../gmail/sendReply.js";
import type { ReplyAttachment } from "../gmail/sendReply.js";
import { sendNewEmail } from "../gmail/sendNew.js";
import { ensureCategoryChannel } from "../gmail/sync.js";
import { createGoogleLinkState, googleLinkUrl } from "../routes/oauthGoogle.js";
```

- [ ] **Step 2: Add the `/compose` command handler**

Add after the existing `/email-link` command handler (after line 30, before `app.message`):

```typescript
  app.command("/compose", async ({ ack, command, client }) => {
    const teamId = command.team_id;
    const ws = await getWorkspaceBySlackTeamId(teamId);
    if (!ws) {
      await ack({ response_type: "ephemeral", text: "Workspace not installed." });
      return;
    }

    const acct = await getSlackUserGmailByWorkspaceAndUser(ws.id, command.user_id);
    if (!acct?.google_email) {
      await ack({ response_type: "ephemeral", text: "Link your Gmail first with /email-link" });
      return;
    }

    await ack();

    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: "modal",
        callback_id: "compose_email",
        title: { type: "plain_text", text: "Compose Email" },
        submit: { type: "plain_text", text: "Send" },
        blocks: [
          {
            type: "input",
            block_id: "to_block",
            label: { type: "plain_text", text: "To" },
            element: {
              type: "plain_text_input",
              action_id: "to_input",
              placeholder: { type: "plain_text", text: "recipient@example.com" },
            },
          },
          {
            type: "input",
            block_id: "cc_block",
            label: { type: "plain_text", text: "CC" },
            optional: true,
            element: {
              type: "plain_text_input",
              action_id: "cc_input",
              placeholder: { type: "plain_text", text: "cc@example.com" },
            },
          },
          {
            type: "input",
            block_id: "bcc_block",
            label: { type: "plain_text", text: "BCC" },
            optional: true,
            element: {
              type: "plain_text_input",
              action_id: "bcc_input",
              placeholder: { type: "plain_text", text: "bcc@example.com" },
            },
          },
          {
            type: "input",
            block_id: "subject_block",
            label: { type: "plain_text", text: "Subject" },
            element: {
              type: "plain_text_input",
              action_id: "subject_input",
            },
          },
          {
            type: "input",
            block_id: "body_block",
            label: { type: "plain_text", text: "Body" },
            element: {
              type: "plain_text_input",
              action_id: "body_input",
              multiline: true,
            },
          },
        ],
      },
    });
  });
```

- [ ] **Step 3: Add the modal submission handler**

Add after the `/compose` command handler (before `app.message`):

```typescript
  app.view("compose_email", async ({ ack, view, body, logger }) => {
    await ack();

    const userId = body.user.id;
    const teamId = body.team?.id ?? view.team_id;
    const values = view.state.values;

    const to = values.to_block?.to_input?.value?.trim() ?? "";
    const cc = values.cc_block?.cc_input?.value?.trim() ?? "";
    const bcc = values.bcc_block?.bcc_input?.value?.trim() ?? "";
    const subject = values.subject_block?.subject_input?.value?.trim() ?? "";
    const bodyText = values.body_block?.body_input?.value?.trim() ?? "";

    if (!to || !subject) return;

    const ws = await getWorkspaceBySlackTeamId(teamId);
    if (!ws) return;

    const acct = await getSlackUserGmailByWorkspaceAndUser(ws.id, userId);
    if (!acct?.google_email) return;

    try {
      const { threadId } = await sendNewEmail({
        account: acct,
        userEmail: acct.google_email,
        to,
        cc: cc || undefined,
        bcc: bcc || undefined,
        subject,
        bodyText,
      });

      // Post sent message as a thread in mail-primary
      const botToken = decryptBotToken(ws);
      const web = new WebClientCtor(botToken);

      const channelId = await ensureCategoryChannel({
        web,
        workspaceId: ws.id,
        slackUserId: userId,
        category: "primary",
      });

      const toLine = cc ? `${to} (CC: ${cc})` : to;
      const text = `*To:* ${toLine}\n*Subject:* ${subject}\n\n${bodyText}`;

      const post = await web.chat.postMessage({
        channel: channelId,
        text,
        mrkdwn: true,
      });

      if (post.ts) {
        await insertThreadSlackThreadOrGet({
          workspaceId: ws.id,
          slackUserId: userId,
          gmailThreadId: threadId,
          slackChannelId: channelId,
          slackThreadTs: post.ts,
          subject,
          lastMessageId: null,
        });
      }
    } catch (e) {
      logger.error("Failed to send compose email", e);
    }
  });
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/slack/boltApp.ts
git commit -m "feat: add /compose command with modal for sending new emails

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 4: Final Verification

### Task 4: End-to-end compilation check

- [ ] **Step 1: Full TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2: Verify all files**

Run: `git diff --stat HEAD~3`
Expected files:
- `src/gmail/sendNew.ts` — new file
- `src/gmail/sync.ts` — export added
- `src/slack/boltApp.ts` — compose command + modal handler
