<p align="center">
  <img src="assets/logo.svg" alt="Slack Mailbot Logo" width="128" height="128">
</p>

<h1 align="center">Slack Mailbot</h1>

<p align="center">
  <strong>Your Gmail inbox, inside Slack.</strong><br>
  Read, reply, compose, and manage email — without leaving your workspace.
</p>

<p align="center">
  <a href="#features">Features</a> &bull;
  <a href="#how-it-works">How It Works</a> &bull;
  <a href="#setup">Setup</a> &bull;
  <a href="#slack-app-configuration">Slack App Config</a> &bull;
  <a href="#deployment">Deployment</a> &bull;
  <a href="#usage">Usage</a>
</p>

---

## Features

- **Category Channels** — Emails automatically sort into `mail-primary`, `mail-social`, `mail-promotions`, `mail-updates`, and `mail-forums` based on Gmail's built-in categories
- **Threaded Conversations** — Each email thread becomes a Slack thread. Replies from the same conversation stay grouped together
- **Reply from Slack** — Type a reply in any email thread and it sends as a real email, complete with your display name and proper threading headers
- **Compose New Emails** — Use `/compose` to open a modal with To, CC, BCC, Subject, and Body fields. Sent messages appear as threads for reply tracking
- **Full Attachment Support** — Incoming email attachments are uploaded to Slack. Files you attach in Slack are included in outgoing emails as MIME attachments
- **View in Gmail** — Every message includes a link to view the full rich HTML version in Gmail
- **Real-Time Sync** — Powered by Google Cloud Pub/Sub push notifications, not polling. Emails arrive in Slack within seconds
- **Privacy First** — Each user gets their own private channels. Tokens are encrypted at rest with AES-256-GCM
- **Auto Mark as Read** — Emails synced to Slack are automatically marked as read in Gmail

## How It Works

```
Gmail Inbox                     Slack Workspace
  |                                |
  |  (Pub/Sub push notification)   |
  |------------------------------->|
  |                                |
  |  Category detection            |  #mail-primary
  |  (Primary/Social/Promos/etc)   |  #mail-social
  |                                |  #mail-promotions
  |                                |  ...
  |                                |
  |  Reply in thread ------------->|  Sent as email via Gmail API
  |                                |
  |  /compose ---modal------------>|  New email sent, thread created
  |                                |
  |  Attachments <---------------->|  Bidirectional file support
```

## Setup

### Prerequisites

- **Node.js** >= 20
- **PostgreSQL** database
- **Google Cloud project** with Gmail API and Cloud Pub/Sub enabled
- **Slack app** (created at [api.slack.com/apps](https://api.slack.com/apps))
- A publicly reachable server (for Slack events and Google Pub/Sub webhooks)

### 1. Clone and install

```bash
git clone https://github.com/your-username/slack-mail.git
cd slack-mail
npm install
```

### 2. Configure environment

Copy the example and fill in your values:

```bash
cp .env.example .env
```

```env
# Slack
SLACK_CLIENT_ID=your-slack-client-id
SLACK_CLIENT_SECRET=your-slack-client-secret
SLACK_SIGNING_SECRET=your-slack-signing-secret
SLACK_STATE_SECRET=any-random-string-at-least-16-chars

# Google
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_PUBSUB_TOPIC=projects/your-project/topics/gmail-push

# App
APP_BASE_URL=https://your-domain.com
DATABASE_URL=postgresql://user:pass@localhost:5432/slackermail
TOKEN_ENCRYPTION_KEY=your-32-byte-hex-key
PORT=3000
```

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Set up Google Cloud

1. Enable the **Gmail API** in your Google Cloud Console
2. Create **OAuth 2.0 credentials** (Web application type)
   - Authorized redirect URI: `{APP_BASE_URL}/auth/google/callback`
3. Enable **Cloud Pub/Sub API**
4. Create a Pub/Sub topic (e.g., `gmail-push`)
5. Grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on your topic
6. Create a push subscription pointing to `{APP_BASE_URL}/webhooks/gmail-pubsub`

### 4. Set up the database

Create a PostgreSQL database, then run migrations:

```bash
npm run build
npm run start
# Migrations run automatically on startup
```

## Slack App Configuration

Create a new Slack app at [api.slack.com/apps](https://api.slack.com/apps) and configure:

### OAuth & Permissions

**Bot Token Scopes:**

| Scope | Purpose |
|-------|---------|
| `channels:history` | Read channel messages |
| `groups:history` | Read private channel messages |
| `groups:write` | Create private channels |
| `chat:write` | Post messages |
| `commands` | Slash commands |
| `files:read` | Download attached files |
| `files:write` | Upload attachments |
| `reactions:write` | Add checkmark reactions |
| `users:read` | Get user info |

**Redirect URL:** `{APP_BASE_URL}/slack/oauth_redirect`

### Slash Commands

| Command | Request URL | Description |
|---------|------------|-------------|
| `/login` | `{APP_BASE_URL}/slack/events` | Link your Gmail account |
| `/compose` | `{APP_BASE_URL}/slack/events` | Compose a new email |

### Interactivity & Shortcuts

- **Toggle ON**
- **Request URL:** `{APP_BASE_URL}/slack/events`

### Event Subscriptions

- **Toggle ON**
- **Request URL:** `{APP_BASE_URL}/slack/events`
- **Subscribe to bot events:** `message.channels`, `message.groups`

## Deployment

### Build

```bash
npm run build
```

### Run

```bash
npm start
```

### systemd (production)

A service file is included at `deploy/slacker-mail.service`:

```bash
sudo cp deploy/slacker-mail.service /etc/systemd/system/
# Edit paths in the service file to match your setup
sudo systemctl daemon-reload
sudo systemctl enable slacker-mail
sudo systemctl start slacker-mail
```

View logs:

```bash
sudo journalctl -u slacker-mail -f
```

## Usage

### Link your Gmail

Type `/login` in any Slack channel. Click the link to authorize Gmail access.

### Reading email

Emails automatically appear in your private category channels:

- **#mail-primary** — Important, personal emails
- **#mail-social** — Social network notifications
- **#mail-promotions** — Marketing and promotional emails
- **#mail-updates** — Bills, receipts, order confirmations
- **#mail-forums** — Mailing lists and forum posts

Each email thread is a Slack thread. New replies to a conversation appear as threaded messages.

### Replying to email

Type a reply in any email thread. Your message is sent as a real email with proper threading. A checkmark reaction confirms it was sent.

You can also drag files into the thread — they'll be attached to the outgoing email.

### Composing new email

Type `/compose` to open a form with To, CC, BCC, Subject, and Body fields. After sending, the email appears as a new thread in #mail-primary so you can track replies.

---

<p align="center">
  Built with <a href="https://slack.dev/bolt-js">Slack Bolt</a> and the <a href="https://developers.google.com/gmail/api">Gmail API</a>
</p>
