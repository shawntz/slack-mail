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

export function registerSlackHandlers(app: App): void {
  app.command("/login", async ({ ack, command }) => {
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

  app.command("/compose", async ({ ack, command, client }) => {
    const teamId = command.team_id;
    const ws = await getWorkspaceBySlackTeamId(teamId);
    if (!ws) {
      await ack({ response_type: "ephemeral", text: "Workspace not installed." });
      return;
    }

    const acct = await getSlackUserGmailByWorkspaceAndUser(ws.id, command.user_id);
    if (!acct?.google_email) {
      await ack({ response_type: "ephemeral", text: "Link your Gmail first with /login" });
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
