# Bidirectional Attachment Support

**Date:** 2026-03-26
**Status:** Approved

## Summary

Add full attachment support in both directions: incoming email attachments are uploaded to Slack as files in the email's thread, and files attached to Slack thread replies are included as MIME attachments in the outgoing Gmail reply. All file types supported, no size limit (Gmail's 25MB cap is the natural ceiling).

## Design Decisions

- **Direct streaming** — attachments are fetched and uploaded in-memory, no temp files
- **All file types** — no filtering by MIME type or extension
- **No size limit** — upload everything Gmail provides (max 25MB per Gmail's own limit)
- **Attachments as separate thread messages** — incoming attachments are uploaded to Slack after the text message, appearing as follow-up messages in the same thread
- **No database changes** — attachments are transient (fetch, upload, done)

## Incoming Attachments (Gmail → Slack)

When `ingestOneMessage` processes an email:

1. **Extract attachment metadata** from the Gmail message payload by walking the MIME tree. Parts with a `filename` and `body.attachmentId` are attachments (not inline text parts).
2. **For each attachment**, call `gmail.users.messages.attachments.get` to download the raw bytes (returned as base64-encoded data).
3. **Upload to Slack** via `files.uploadV2` with `thread_ts` set to the email's Slack thread. For new threads, this is the `postTs` of the root message. For existing threads, this is the stored `slack_thread_ts`.
4. Attachments are uploaded after the text message, so they appear as follow-ups in the thread.

### New function in `mime.ts`

`extractAttachments(payload)` — walks the MIME part tree and returns:

```typescript
Array<{ filename: string; mimeType: string; attachmentId: string; size: number }>
```

Filters for parts that have both a `filename` and a `body.attachmentId` (distinguishes real attachments from inline text/html parts).

## Outgoing Attachments (Slack → Gmail)

When the reply handler in `boltApp.ts` receives a threaded message with files:

1. **Detect files** — Slack message events with attachments have a `files` array.
2. **For each file**, get the `url_private_download` from the file object and fetch the bytes using the bot token as a Bearer auth header.
3. **Build a MIME multipart email** — `Content-Type: multipart/mixed` with:
   - Part 1: `text/plain; charset=utf-8` — the message body text
   - Part 2+: each attachment with `Content-Type` matching the file's MIME type, `Content-Transfer-Encoding: base64`, and `Content-Disposition: attachment; filename="name.ext"`
4. **Send via Gmail** — same `gmail.users.messages.send` call, but with the multipart raw body.
5. When no files are present, keep the current simple plain text format (no multipart overhead).

### Changes to `sendReply.ts`

- Accept an optional `files` parameter: `Array<{ filename: string; mimeType: string; content: Buffer }>`
- When files are present, build `multipart/mixed` with a generated boundary string
- When no files, use current plain text format (backward compatible)
- Generate boundary using a random string to avoid collisions with email content

### Changes to `boltApp.ts`

- Check for `files` array on the incoming Slack message
- For each file, download content via `url_private_download` with bot token auth
- Pass downloaded file buffers to `sendGmailReplyFromSlack`

## New Slack Scopes

- `files:write` — required for `files.uploadV2` (incoming attachments → Slack)
- `files:read` — required to download file content from Slack (outgoing attachments → Gmail)

## Files to Modify

| File | Change |
|------|--------|
| `src/gmail/mime.ts` | Add `extractAttachments()` function |
| `src/gmail/sync.ts` | After posting text message, download Gmail attachments and upload to Slack thread |
| `src/gmail/sendReply.ts` | Support optional files parameter; build multipart MIME when files present; generate boundary |
| `src/slack/boltApp.ts` | Detect files on message, download from Slack, pass to reply function |
| `src/server.ts` | Add `files:read` and `files:write` to `BOT_SCOPES` |
