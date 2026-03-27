import type { App } from "@slack/bolt";
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

export function registerSlackHandlers(app: App): void {
  app.command("/email-link", async ({ ack, command }) => {
    const teamId = command.team_id;
    const ws = await getWorkspaceBySlackTeamId(teamId);
    if (!ws) {
      await ack({
        response_type: "ephemeral",
        text: "This workspace is not installed. Install the app from your Slack admin first.",
      });
      return;
    }
    const stateToken = await createGoogleLinkState(ws.id, command.user_id);
    const url = googleLinkUrl(stateToken);
    await ack({
      response_type: "ephemeral",
      text: `Connect your Gmail (link expires in 10 minutes):\n${url}`,
    });
  });

  app.message(async ({ message, context, client, logger }) => {
    if ("subtype" in message && message.subtype) return;
    if (!("user" in message) || !message.user) return;
    if ("bot_id" in message && message.bot_id) return;
    if (message.user === context.botUserId) return;
    if (!("channel" in message) || typeof message.channel !== "string") return;
    const hasText = "text" in message && typeof message.text === "string" && message.text.trim();
    const hasFiles = "files" in message && Array.isArray(message.files) && message.files.length > 0;
    if (!hasText && !hasFiles) return;

    // Only handle threaded replies — ignore top-level messages in category channels
    if (!("thread_ts" in message) || !message.thread_ts) return;
    if (message.thread_ts === message.ts) return;

    const mapping = await getThreadMappingBySlackThread(message.channel, message.thread_ts);
    if (!mapping) return;
    if (mapping.slack_user_id !== message.user) return;

    const acct = await getSlackUserGmailByWorkspaceAndUser(mapping.workspace_id, message.user);
    if (!acct?.google_email) return;

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

    try {
      await sendGmailReplyFromSlack({
        account: acct,
        gmailThreadId: mapping.gmail_thread_id,
        userEmail: acct.google_email,
        bodyText: hasText ? (message as { text: string }).text : "",
        files: files.length > 0 ? files : undefined,
      });
    } catch (e) {
      logger.error(e);
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.thread_ts,
        text: `Could not send email: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    try {
      await client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: "white_check_mark",
      });
    } catch (e) {
      logger.warn("Failed to add reaction", e);
    }
  });
}
