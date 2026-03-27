import slackWebApi from "@slack/web-api";
import type { WebClient } from "@slack/web-api";

const { WebClient: WebClientCtor } = slackWebApi;
import { createGmailForRefresh } from "./client.js";
import { extractAttachments, extractPlainText, formatFromForSlack, getHeader } from "./mime.js";
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

export type LinkedGmailAccount = SlackUserGmailRow & { slack_team_id: string };

function emailFromHeader(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return (m ? m[1]! : value).trim().toLowerCase();
}

function labelToCategory(labelIds: string[]): GmailCategory {
  if (labelIds.includes("CATEGORY_SOCIAL")) return "social";
  if (labelIds.includes("CATEGORY_PROMOTIONS")) return "promotions";
  if (labelIds.includes("CATEGORY_UPDATES")) return "updates";
  if (labelIds.includes("CATEGORY_FORUMS")) return "forums";
  return "primary";
}

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

  try {
    await params.web.conversations.invite({
      channel: channelId,
      users: params.slackUserId,
    });
  } catch (e: unknown) {
    const err = e as { data?: { error?: string } };
    if (err.data?.error !== "already_in_channel") throw e;
  }

  const storedChannelId = await insertCategoryChannelOrGet({
    workspaceId: params.workspaceId,
    slackUserId: params.slackUserId,
    category: params.category,
    slackChannelId: channelId,
  });

  // If we lost a race, archive the orphaned channel we just created
  if (storedChannelId !== channelId) {
    try {
      await params.web.conversations.archive({ channel: channelId });
    } catch {
      // best-effort cleanup
    }
  }

  return storedChannelId;
}

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

  if (postTs) {
    await updateThreadSlackLastMessageId(
      params.workspaceId,
      params.account.slack_user_id,
      threadId,
      rfcId,
    );
  }
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
            await ingestOneMessage({
              account,
              workspaceId: account.workspace_id,
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
