# Bidirectional Attachment Support — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full attachment support in both directions — incoming Gmail attachments uploaded to Slack threads, outgoing Slack file attachments encoded as MIME multipart in Gmail replies.

**Architecture:** `mime.ts` gets a new `extractAttachments()` helper. `sync.ts` downloads Gmail attachments and uploads them to Slack threads after the text message. `sendReply.ts` accepts optional file buffers and builds `multipart/mixed` MIME when files are present. `boltApp.ts` detects Slack files on messages and downloads them before passing to the reply function.

**Tech Stack:** TypeScript, Gmail API (messages.attachments.get), Slack Web API (files.uploadV2), MIME multipart encoding

**Spec:** `docs/superpowers/specs/2026-03-26-attachment-support-design.md`

---

## Chunk 1: Incoming Attachments (Gmail → Slack)

### Task 1: Add Slack file scopes

**Files:**
- Modify: `src/server.ts:20-28`

- [ ] **Step 1: Add `files:read` and `files:write` to `BOT_SCOPES`**

In `src/server.ts`, replace the `BOT_SCOPES` array (lines 20-28) with:

```typescript
const BOT_SCOPES = [
  "channels:history",
  "groups:history",
  "groups:write",
  "chat:write",
  "commands",
  "files:read",
  "files:write",
  "reactions:write",
  "users:read",
];
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: add files:read and files:write Slack bot scopes

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add `extractAttachments` to mime.ts

**Files:**
- Modify: `src/gmail/mime.ts` (add function after line 31, after `extractPlainText`)

- [ ] **Step 1: Add the `AttachmentMeta` type and `extractAttachments` function**

Add after the `extractPlainText` function (after line 32) in `src/gmail/mime.ts`:

```typescript
export type AttachmentMeta = {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
};

export function extractAttachments(payload: gmail_v1.Schema$MessagePart | undefined): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];
  walkParts(payload, (p) => {
    const filename = p.filename;
    const attachmentId = p.body?.attachmentId;
    if (filename && attachmentId) {
      attachments.push({
        filename,
        mimeType: p.mimeType ?? "application/octet-stream",
        attachmentId,
        size: p.body?.size ?? 0,
      });
    }
  });
  return attachments;
}
```

This reuses the existing `walkParts` helper. It filters for MIME parts that have both a `filename` (meaning it's a named attachment, not an inline text/html part) and a `body.attachmentId` (meaning the content must be fetched separately via the attachments API — it wasn't inlined in the message payload).

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/gmail/mime.ts
git commit -m "feat: add extractAttachments helper for Gmail MIME parts

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Upload incoming attachments to Slack threads

**Files:**
- Modify: `src/gmail/sync.ts`

- [ ] **Step 1: Add `extractAttachments` to imports**

In `src/gmail/sync.ts`, update the import from `./mime.js` (line 6) to include `extractAttachments`:

```typescript
import { extractAttachments, extractPlainText, formatFromForSlack, getHeader } from "./mime.js";
```

- [ ] **Step 2: Add attachment upload logic after the text message post**

In `ingestOneMessage`, after the thread mapping insert block (after line 190: the closing `}` of `if (!existingThread && postTs)`) and before the "Mark as read" comment (line 192), add:

```typescript
  // Upload attachments to Slack thread
  const attachmentThreadTs = threadTs ?? postTs;
  if (attachmentThreadTs) {
    const attachments = extractAttachments(msg.data.payload);
    for (const att of attachments) {
      try {
        const attData = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: params.messageId,
          id: att.attachmentId,
        });
        const base64 = attData.data.data;
        if (!base64) continue;
        const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
        const fileBuffer = Buffer.from(normalized, "base64");
        await params.web.filesUploadV2({
          channel_id: channelId,
          thread_ts: attachmentThreadTs,
          filename: att.filename,
          file: fileBuffer,
        });
      } catch (e) {
        console.error("Failed to upload attachment to Slack", att.filename, e);
      }
    }
  }
```

Key details:
- `attachmentThreadTs` is either the existing thread's `slack_thread_ts` (for follow-up messages) or the just-posted root message's `postTs` (for new threads). This ensures attachments land in the correct Slack thread.
- Gmail returns attachment data as URL-safe base64 (`-` and `_` instead of `+` and `/`). We normalize before decoding, matching the pattern in `mime.ts:decodeBody`.
- Each attachment upload is wrapped in its own try/catch — if one fails, the rest still upload (per spec).
- `filesUploadV2` is the current Slack API method for file uploads (replaces deprecated `files.upload`).

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/gmail/sync.ts
git commit -m "feat: upload incoming email attachments to Slack threads

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 2: Outgoing Attachments (Slack → Gmail)

### Task 4: Add multipart MIME support to sendReply.ts

**Files:**
- Modify: `src/gmail/sendReply.ts`

- [ ] **Step 1: Add the `ReplyAttachment` type and `randomBoundary` helper**

First, add the `randomBytes` import to the top of `src/gmail/sendReply.ts` (with the other imports, lines 1-4):

```typescript
import { randomBytes } from "node:crypto";
```

Then add the following after the `encodeRawRfc2822` function (after line 15):

```typescript

export type ReplyAttachment = {
  filename: string;
  mimeType: string;
  content: Buffer;
};

function randomBoundary(): string {
  return `----=_Part_${randomBytes(16).toString("hex")}`;
}

function buildMultipartRaw(params: {
  headers: string[];
  bodyText: string;
  files: ReplyAttachment[];
}): string {
  const boundary = randomBoundary();
  const headerLines = [
    ...params.headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
  ];

  const parts: string[] = [];

  // Text part
  parts.push(
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    params.bodyText,
  );

  // Attachment parts
  for (const file of params.files) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${file.mimeType}; name="${file.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${file.filename}"`,
      "",
      file.content.toString("base64"),
    );
  }

  parts.push(`--${boundary}--`);

  const raw = headerLines.join("\r\n") + "\r\n" + parts.join("\r\n") + "\r\n";
  return Buffer.from(raw, "utf8").toString("base64url");
}
```

- [ ] **Step 2: Update `sendGmailReplyFromSlack` to accept optional files**

Update the function signature (line 17) to add an optional `files` parameter:

```typescript
export async function sendGmailReplyFromSlack(params: {
  account: SlackUserGmailRow;
  gmailThreadId: string;
  userEmail: string;
  bodyText: string;
  files?: ReplyAttachment[];
}): Promise<void> {
```

- [ ] **Step 3: Replace the raw email building logic**

Replace the block from `const rawLines = [` through `raw: encodeRawRfc2822(rawLines),` (lines 82-97) with:

```typescript
  const commonHeaders = [
    `From: ${fromHeader}`,
    `To: ${replyTo}`,
    `Subject: ${subject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references}`,
  ];

  let raw: string;
  if (params.files && params.files.length > 0) {
    raw = buildMultipartRaw({
      headers: commonHeaders,
      bodyText: params.bodyText,
      files: params.files,
    });
  } else {
    const rawLines = [
      ...commonHeaders,
      "Content-Type: text/plain; charset=utf-8",
      "",
      params.bodyText,
    ];
    raw = encodeRawRfc2822(rawLines);
  }

  await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      threadId: params.gmailThreadId,
      raw,
    },
  });
```

When no files are present, this produces the exact same output as before (backward compatible). When files are present, it builds a `multipart/mixed` MIME message.

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/gmail/sendReply.ts
git commit -m "feat: support multipart MIME with file attachments in outgoing replies

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Download Slack files and pass to reply in boltApp.ts

**Files:**
- Modify: `src/slack/boltApp.ts`

- [ ] **Step 1: Update imports**

Replace the imports at the top of `src/slack/boltApp.ts` (lines 1-8). Add `decryptBotToken`, `getWorkspaceById`, and the `ReplyAttachment` type:

```typescript
import {
  decryptBotToken,
  getSlackUserGmailByWorkspaceAndUser,
  getThreadMappingBySlackThread,
  getWorkspaceById,
  getWorkspaceBySlackTeamId,
} from "../db/repos.js";
import { sendGmailReplyFromSlack } from "../gmail/sendReply.js";
import type { ReplyAttachment } from "../gmail/sendReply.js";
import { createGoogleLinkState, googleLinkUrl } from "../routes/oauthGoogle.js";
```

Note: we re-add `getWorkspaceById` because we need the workspace row to get the bot token for downloading files.

- [ ] **Step 2: Update the message handler to allow file-only messages**

Replace the text validation guard (line 35):

```typescript
    if (!("text" in message) || typeof message.text !== "string" || !message.text.trim()) return;
```

With a guard that allows messages with files even if text is empty:

```typescript
    const hasText = "text" in message && typeof message.text === "string" && message.text.trim();
    const hasFiles = "files" in message && Array.isArray(message.files) && message.files.length > 0;
    if (!hasText && !hasFiles) return;
```

- [ ] **Step 3: Add file download logic before the `sendGmailReplyFromSlack` call**

After the `if (!acct?.google_email) return;` line (line 46) and before the `try {` block (line 48), add:

```typescript
    // Download attached files from Slack
    const files: ReplyAttachment[] = [];
    if (hasFiles) {
      const ws = await getWorkspaceById(mapping.workspace_id);
      if (!ws) return;
      const botToken = decryptBotToken(ws);
      for (const f of (message as { files: Array<{ url_private_download?: string; name?: string; mimetype?: string }> }).files) {
        if (!f.url_private_download) continue;
        try {
          const resp = await fetch(f.url_private_download, {
            headers: { Authorization: `Bearer ${botToken}` },
          });
          if (!resp.ok) continue;
          const buf = Buffer.from(await resp.arrayBuffer());
          files.push({
            filename: f.name ?? "attachment",
            mimeType: f.mimetype ?? "application/octet-stream",
            content: buf,
          });
        } catch (e) {
          logger.warn("Failed to download Slack file", f.name, e);
        }
      }
    }
```

- [ ] **Step 4: Update the `sendGmailReplyFromSlack` call to pass files**

Update the call (currently lines 49-54) to include files and handle empty text:

```typescript
      await sendGmailReplyFromSlack({
        account: acct,
        gmailThreadId: mapping.gmail_thread_id,
        userEmail: acct.google_email,
        bodyText: hasText ? (message as { text: string }).text : "",
        files: files.length > 0 ? files : undefined,
      });
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/slack/boltApp.ts
git commit -m "feat: download Slack file attachments and include in outgoing email replies

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 3: Final Verification

### Task 6: End-to-end compilation and cleanup

**Files:**
- All modified files

- [ ] **Step 1: Full TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2: Verify all files were modified as expected**

Run: `git diff --stat HEAD~5` (5 commits back covers all tasks)
Expected files:
- `src/server.ts` — scopes
- `src/gmail/mime.ts` — extractAttachments
- `src/gmail/sync.ts` — attachment upload
- `src/gmail/sendReply.ts` — multipart MIME
- `src/slack/boltApp.ts` — file download + pass to reply

- [ ] **Step 3: Commit any cleanup if needed**

```bash
git add -A
git commit -m "chore: cleanup after attachment support implementation

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
