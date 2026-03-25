import { createHash } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { createGmailForRefresh } from "./client.js";
import { extractPlainText, getHeader } from "./mime.js";
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

function channelBaseName(threadId: string): string {
  const h = createHash("sha256").update(threadId).digest("hex").slice(0, 10);
  return `mail-${h}`;
}

async function createPrivateMailChannel(web: WebClient, threadId: string): Promise<string> {
  const base = channelBaseName(threadId);
  const tryName = async (name: string): Promise<string> => {
    const res = await web.conversations.create({ name, is_private: true });
    const id = res.channel?.id;
    if (!id) throw new Error("conversations.create missing channel id");
    return id;
  };
  try {
    return await tryName(base);
  } catch (e: unknown) {
    const err = e as { data?: { error?: string } };
    if (err.data?.error === "name_taken") {
      return await tryName(`${base}-${Date.now().toString(36)}`);
    }
    throw e;
  }
}

async function ensureThreadSlackChannel(params: {
  web: WebClient;
  workspaceId: number;
  slackTeamId: string;
  slackUserId: string;
  botUserId: string;
  gmailThreadId: string;
  subject: string | null;
  lastMessageId: string | null;
}): Promise<string> {
  const existing = await getThreadChannelMapping(
    params.workspaceId,
    params.slackUserId,
    params.gmailThreadId,
  );
  if (existing) return existing.slack_channel_id;

  const channelId = await createPrivateMailChannel(params.web, params.gmailThreadId);

  await params.web.conversations.invite({
    channel: channelId,
    users: `${params.slackUserId},${params.botUserId}`,
  });

  return insertThreadChannelOrGet({
    workspaceId: params.workspaceId,
    slackUserId: params.slackUserId,
    gmailThreadId: params.gmailThreadId,
    slackChannelId: channelId,
    subject: params.subject,
    lastMessageId: params.lastMessageId,
  });
}

async function ingestOneMessage(params: {
  account: LinkedGmailAccount;
  workspaceId: number;
  botUserId: string;
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

  const threadId = msg.data.threadId;
  if (!threadId) return;

  const headers = msg.data.payload?.headers;
  const subject = getHeader(headers, "Subject") || "(no subject)";
  const from = getHeader(headers, "From") || "(unknown)";
  const rfcId = getHeader(headers, "Message-ID") || params.messageId;
  const body = extractPlainText(msg.data.payload) || msg.data.snippet || "";

  const channelId = await ensureThreadSlackChannel({
    web: params.web,
    workspaceId: params.workspaceId,
    slackTeamId: params.account.slack_team_id,
    slackUserId: params.account.slack_user_id,
    botUserId: params.botUserId,
    gmailThreadId: threadId,
    subject,
    lastMessageId: rfcId,
  });

  const claimed = await claimGmailMessagePost({
    workspaceId: params.workspaceId,
    gmailMessageId: params.messageId,
    slackChannelId: channelId,
  });
  if (!claimed) return;

  const text = `*From:* ${from}\n*Subject:* ${subject}\n*Message-ID:* \`${rfcId}\`\n\n${body}`;
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
  const web = new WebClient(botTok);
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
            await ingestOneMessage({
              account,
              workspaceId: account.workspace_id,
              botUserId: ws.bot_user_id,
              web,
              messageId: mid,
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
