<p align="center">
  <img src="assets/logo.svg" alt="Slack Mailbot Logo" width="80" height="80">
</p>

<h1 align="center">Slack Mailbot v1.0.0</h1>

<p align="center"><strong>Your Gmail inbox, inside Slack.</strong></p>

---

I'm excited to ship the first release of Slack Mailbot — a self-hosted Slack app that brings your Gmail directly into your workspace. Read, reply, compose, and manage email without ever leaving Slack.

## Highlights

### Category-Based Channels

Emails are automatically organized into private Slack channels based on Gmail's built-in categories:

| Channel | What goes here |
|---------|---------------|
| `#mail-primary` | Important, personal emails |
| `#mail-social` | Social network notifications |
| `#mail-promotions` | Marketing and deals |
| `#mail-updates` | Receipts, bills, confirmations |
| `#mail-forums` | Mailing lists and forums |

Channels are created on-demand — you only see categories that have mail.

### Threaded Conversations

Every email thread maps to a Slack thread. When someone replies to a conversation, it appears as a threaded message in the right channel. No more channel sprawl — one channel per category, not one per email.

### Reply From Slack

Type a reply in any email thread and it sends as a real email. Your display name, proper `In-Reply-To` and `References` headers, and full threading are handled automatically. A checkmark reaction confirms delivery.

### Compose New Emails

Use `/compose` to open a modal with To, CC, BCC, Subject, and Body fields. Sent messages appear as threads in `#mail-primary` so you can track replies.

### Full Attachment Support

- **Incoming** — Email attachments are automatically uploaded to the Slack thread as files
- **Outgoing** — Drag files into a thread reply or compose them — they're sent as proper MIME attachments
- All file types supported, up to Gmail's 25MB limit

### Real-Time Sync

Powered by Google Cloud Pub/Sub push notifications. No polling — emails arrive in Slack within seconds of hitting your inbox. Messages are automatically marked as read in Gmail after syncing.

### View in Gmail

Every synced email includes a "View in Gmail" link to see the full rich HTML version — tables, images, formatting and all.

### Privacy & Security

- Private channels per user — your email is only visible to you
- OAuth tokens encrypted at rest with AES-256-GCM
- CSRF-protected OAuth flows with expiring state tokens
- Self-hosted — your email data never touches a third-party service

## Slash Commands

| Command | Description |
|---------|-------------|
| `/login` | Link your Gmail account via Google OAuth |
| `/compose` | Open a modal to compose and send a new email |

## Technical Details

- **Runtime:** Node.js >= 20
- **Framework:** [Slack Bolt](https://slack.dev/bolt-js) v4 with Express
- **Database:** PostgreSQL
- **Email:** Gmail API with OAuth 2.0
- **Notifications:** Google Cloud Pub/Sub (push)
- **Encryption:** AES-256-GCM for token storage

## Getting Started

See the [README](README.md) for full setup instructions, including:
- Environment configuration
- Google Cloud setup (Gmail API, Pub/Sub)
- Slack app configuration (scopes, commands, events)
- Deployment with systemd

## Known Limitations

- **Text-only compose** — The `/compose` modal sends plain text emails. Attachments can be added as follow-up replies in the thread.
- **No draft support** — Emails are sent immediately; there's no draft/preview step.
- **Single account per user** — Each Slack user can link one Gmail account.
- **Gmail categories required** — Emails without category labels default to `#mail-primary`. Users with Gmail categories disabled will see all mail in primary.

## What's Next

- Draft and preview before sending
- Slack notification preferences (mute categories, quiet hours)
- Multi-account support
- Email search from Slack

---

<p align="center">
  <a href="https://github.com/your-username/slack-mail">GitHub</a> &bull;
  <a href="https://github.com/your-username/slack-mail/issues">Issues</a> &bull;
  <a href="README.md">Setup Guide</a>
</p>
