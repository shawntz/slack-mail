import type { App } from "@slack/bolt";
import {
  getSlackUserGmailByWorkspaceAndUser,
  getThreadMappingBySlackChannel,
  getWorkspaceById,
  getWorkspaceBySlackTeamId,
} from "../db/repos.js";
import { sendGmailReplyFromSlack } from "../gmail/sendReply.js";
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
    if (!("text" in message) || typeof message.text !== "string" || !message.text.trim()) return;

    const mapping = await getThreadMappingBySlackChannel(message.channel);
    if (!mapping) return;
    if (mapping.slack_user_id !== message.user) return;

    const ws = await getWorkspaceById(mapping.workspace_id);
    if (!ws) return;

    const acct = await getSlackUserGmailByWorkspaceAndUser(ws.id, message.user);
    if (!acct?.google_email) return;

    try {
      await sendGmailReplyFromSlack({
        account: acct,
        gmailThreadId: mapping.gmail_thread_id,
        userEmail: acct.google_email,
        bodyText: message.text,
      });
    } catch (e) {
      logger.error(e);
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.ts,
        text: `Could not send email: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });
}
