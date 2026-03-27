# Compose New Email from Slack

**Date:** 2026-03-27
**Status:** Approved

## Summary

Add the ability to compose and send new emails from Slack via a `/compose` slash command that opens a modal with To, CC, BCC, Subject, and Body fields. After sending, the bot posts the sent message as a new thread in the user's `mail-primary` category channel so replies from recipients appear there automatically.

## Design Decisions

- **Slash command + modal** — `/compose` opens a Slack modal form for clean UX with field validation
- **Text-only initial compose** — no file attachments in the first email; user can follow up in the thread with attachments using the existing reply flow
- **Thread in `mail-primary`** — sent messages always go to the primary category channel; recipient replies thread naturally via the Gmail thread ID mapping
- **Separate `sendNew.ts`** — composing a new email is different from replying (no In-Reply-To, no References, no existing thread), so it gets its own file
- **No new scopes** — `commands` and existing bot token cover `views.open` and modal submission

## Slash Command & Modal

### `/compose` command handler

1. User types `/compose` in any channel
2. Bot calls `views.open` with a modal containing:
   - **To** — plain text input, required
   - **CC** — plain text input, optional
   - **BCC** — plain text input, optional
   - **Subject** — plain text input, required
   - **Body** — multiline plain text input, required
3. To, CC, and BCC support comma-separated email addresses

### Modal submission handler

1. Extract and validate inputs (To must be non-empty, Subject must be non-empty)
2. Look up the user's linked Gmail account via `getSlackUserGmailByWorkspaceAndUser`
3. Call `sendNewEmail()` to send the email via Gmail API
4. Post the sent message as a new thread in the user's `mail-primary` category channel
5. Store the Gmail thread ID mapping via `insertThreadSlackThreadOrGet` so recipient replies thread correctly
6. Acknowledge the modal submission

## Email Sending

### New function: `sendNewEmail` in `src/gmail/sendNew.ts`

Accepts:
- `account: SlackUserGmailRow` — the linked Gmail account
- `userEmail: string` — the sender's email
- `to: string` — comma-separated recipient addresses
- `cc: string` — comma-separated CC addresses (optional)
- `bcc: string` — comma-separated BCC addresses (optional)
- `subject: string`
- `bodyText: string`

Returns: `{ messageId: string; threadId: string }` — needed for thread mapping

Behavior:
1. Fetches display name from Gmail send-as settings (same pattern as `sendReply.ts`)
2. Builds RFC 2822 email with From, To, CC, BCC, Subject, Content-Type headers
3. Sends via `gmail.users.messages.send` with no `threadId` (new conversation)
4. Returns the response's `id` and `threadId`

### Thread creation after sending

1. Get or create the `mail-primary` category channel for the user (reuse `ensureCategoryChannel` from `sync.ts`)
2. Post a message to the channel: `*To:* recipient(s)\n*Subject:* subject\n\nbody`
3. Store thread mapping via `insertThreadSlackThreadOrGet` with the Gmail `threadId` and the Slack message `ts`
4. Future incoming replies from recipients will be picked up by the existing sync flow and posted as threaded replies

## Files to Modify

| File | Change |
|------|--------|
| `src/gmail/sendNew.ts` | New file — `sendNewEmail()` function |
| `src/slack/boltApp.ts` | Add `/compose` command handler (`views.open`) and `view_submission` handler |
| `src/gmail/sync.ts` | Export `ensureCategoryChannel` so boltApp.ts can reuse it |
