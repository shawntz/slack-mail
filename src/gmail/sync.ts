import { createHash } from "node:crypto";
import slackWebApi from "@slack/web-api";
import type { WebClient } from "@slack/web-api";

const { WebClient: WebClientCtor } = slackWebApi;
import type { gmail_v1 } from "googleapis";
import { createGmailForRefresh } from "./client.js";
import { extractPlainText, formatFromForSlack, getHeader } from "./mime.js";
import {
  claimGmailMessagePost,
  decryptBotToken,
  decryptGoogleRefreshToken,
  finalizeGmailMessageSlackTs,
  getThreadChannelMapping,
  getWorkspaceBySlackTeamId,
  insertThreadChannelOrGet,
  releaseGmailMessageClaim,
  updateGmailHistoryId,
  updateThreadLastMessageId,
} from "../db/repos.js";
import type { SlackUserGmailRow } from "../db/repos.js";

export type LinkedGmailAccount = SlackUserGmailRow & { slack_team_id: string };

function slackChannelSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "mail";
}

function channelBaseName(params: {
  threadId: string;
  firstMessageDateMs: number | null;
  subject: string | null;
}): string {
  const h = createHash("sha256").update(params.threadId).digest("hex").slice(0, 8);
  const dateStr = params.firstMessageDateMs ? new Date(params.firstMessageDateMs).toISOString().slice(0, 10) : "unknown";
  const subjectSlug = params.subject ? slackChannelSlug(params.subject).slice(0, 40) : "thread";

  // Slack channel `name` needs: [a-z0-9-], <= 80-ish, and no spaces.
  // Keep a short hash suffix to avoid collisions.
  let base = `mail-${dateStr}-${subjectSlug}-${h}`;
  base = base.replace(/[^a-z0-9-]/g, "-");
  if (base.length > 79) base = base.slice(0, 79).replace(/-+$/g, "");
  return base;
}

function emailFromHeader(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return (m ? m[1]! : value).trim().toLowerCase();
}

async function createPrivateMailChannel(web: WebClient, baseName: string): Promise<string> {
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

async function ensureThreadSlackChannel(params: {
  web: WebClient;
  gmail: gmail_v1.Gmail;
  workspaceId: number;
  slackTeamId: string;
  slackUserId: string;
  gmailThreadId: string;
  subject: string | null;
  firstMessageDateMs: number | null;
  lastMessageId: string | null;
}): Promise<string> {
  const existing = await getThreadChannelMapping(
    params.workspaceId,
    params.slackUserId,
    params.gmailThreadId,
  );
  if (existing) return existing.slack_channel_id;

  const firstSummary = await getThreadFirstMessageSummary(params.gmail, params.gmailThreadId);
  const computedFirstDateMs = firstSummary.firstMessageDateMs ?? params.firstMessageDateMs;
  const subjectForChannel = firstSummary.subject ?? params.subject;
  const base = channelBaseName({
    threadId: params.gmailThreadId,
    firstMessageDateMs: computedFirstDateMs,
    subject: subjectForChannel,
  });

  const channelId = await createPrivateMailChannel(params.web, base);

  await params.web.conversations.invite({
    channel: channelId,
    users: params.slackUserId,
  });

  return insertThreadChannelOrGet({
    workspaceId: params.workspaceId,
    slackUserId: params.slackUserId,
    gmailThreadId: params.gmailThreadId,
    slackChannelId: channelId,
    subject: subjectForChannel,
    lastMessageId: params.lastMessageId,
  });
}

async function getThreadFirstMessageSummary(
  gmail: gmail_v1.Gmail,
  gmailThreadId: string,
): Promise<{ firstMessageDateMs: number | null; subject: string | null }> {
  try {
    // We only need earliest message's internalDate + Subject header for naming.
    const thread = await gmail.users.threads.get({
      userId: "me",
      id: gmailThreadId,
      format: "metadata",
      metadataHeaders: ["Subject"],
    });
    const messages = thread.data.messages ?? [];
    if (!messages.length) return { firstMessageDateMs: null, subject: null };

    const first = [...messages].sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0))[0]!;
    const firstMessageDateMs = first.internalDate ? Number(first.internalDate) : null;
    const headers = first.payload?.headers;
    const subject = getHeader(headers, "Subject") || null;
    return { firstMessageDateMs, subject };
  } catch {
    // Naming is a nice-to-have; avoid breaking ingestion.
    return { firstMessageDateMs: null, subject: null };
  }
}

async function ingestOneMessage(params: {
  account: LinkedGmailAccount;
  workspaceId: number;
  web: WebClient;
  messageId: string;
  firstMessageDateMs: number | null;
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

  const channelId = await ensureThreadSlackChannel({
    web: params.web,
    gmail,
    workspaceId: params.workspaceId,
    slackTeamId: params.account.slack_team_id,
    slackUserId: params.account.slack_user_id,
    gmailThreadId: threadId,
    subject,
    firstMessageDateMs: params.firstMessageDateMs,
    lastMessageId: rfcId,
  });

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
    });
    postTs = post.ts;
    if (postTs) {
      await finalizeGmailMessageSlackTs(params.messageId, postTs);
    }
  } catch (e) {
    await releaseGmailMessageClaim(params.messageId);
    throw e;
  }

  // Mark the Gmail message as read once we've posted it to Slack.
  // Note: this marks as read on "synced to Slack", not when the human user clicks/opens the Slack message.
  if (labels.includes("UNREAD")) {
    try {
      await gmail.users.messages.modify({
        userId: "me",
        id: params.messageId,
        requestBody: {
          removeLabelIds: ["UNREAD"],
        },
      });
    } catch (e) {
      console.error("Failed to mark Gmail message as read", params.messageId, e);
    }
  }

  await updateThreadLastMessageId(
    params.workspaceId,
    params.account.slack_user_id,
    threadId,
    rfcId,
  );
}

export async function processGmailAccountInboxDelta(account: LinkedGmailAccount): Promise<void> {
  const ws = await getWorkspaceBySlackTeamId(account.slack_team_id);
  if (!ws) return;

  const botTok = decryptBotToken(ws);
  const web = new WebClientCtor(botTok);
  const gmail = createGmailForRefresh(decryptGoogleRefreshToken(account));

  let startHistoryId = account.history_id;
  if (!startHistoryId) {
    const prof = await gmail.users.getProfile({ userId: "me" });
    const hid = prof.data.historyId;
    if (hid) await updateGmailHistoryId(account.id, hid);
    return;
  }

  let pageToken: string | undefined;
  let latestHistoryId = startHistoryId;

  try {
    for (;;) {
      const hist = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        pageToken,
        maxResults: 100,
      });
      if (hist.data.historyId) latestHistoryId = hist.data.historyId;

      for (const h of hist.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          const mid = added.message?.id;
          if (mid) {
            const firstMessageDateMs = added.message?.internalDate ? Number(added.message.internalDate) : null;
            await ingestOneMessage({
              account,
              workspaceId: account.workspace_id,
              web,
              messageId: mid,
              firstMessageDateMs,
            });
          }
        }
      }

      pageToken = hist.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
  } catch (e: unknown) {
    const err = e as { code?: number; message?: string };
    const notFound =
      err.code === 404 || (typeof err.message === "string" && err.message.includes("notFound"));
    if (notFound) {
      const prof = await gmail.users.getProfile({ userId: "me" });
      if (prof.data.historyId) await updateGmailHistoryId(account.id, prof.data.historyId);
      return;
    }
    throw e;
  }

  if (latestHistoryId && latestHistoryId !== startHistoryId) {
    await updateGmailHistoryId(account.id, latestHistoryId);
  }
}
