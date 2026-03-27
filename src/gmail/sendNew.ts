import { createGmailForRefresh } from "./client.js";
import { decryptGoogleRefreshToken } from "../db/repos.js";
import type { SlackUserGmailRow } from "../db/repos.js";

function encodeRawRfc2822(lines: string[]): string {
  const raw = lines.join("\r\n");
  return Buffer.from(raw, "utf8").toString("base64url");
}

export async function sendNewEmail(params: {
  account: SlackUserGmailRow;
  userEmail: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  bodyText: string;
}): Promise<{ messageId: string; threadId: string }> {
  const gmail = createGmailForRefresh(decryptGoogleRefreshToken(params.account));

  // Fetch display name from Gmail send-as settings
  let fromHeader = params.userEmail;
  try {
    const sendAs = await gmail.users.settings.sendAs.list({ userId: "me" });
    const primary = sendAs.data.sendAs?.find((s) => s.isPrimary);
    if (primary?.displayName) {
      fromHeader = `"${primary.displayName}" <${params.userEmail}>`;
    }
  } catch {
    // Fall back to bare email
  }

  const headers = [
    `From: ${fromHeader}`,
    `To: ${params.to}`,
  ];
  if (params.cc) headers.push(`Cc: ${params.cc}`);
  if (params.bcc) headers.push(`Bcc: ${params.bcc}`);
  headers.push(
    `Subject: ${params.subject}`,
    "Content-Type: text/plain; charset=utf-8",
  );

  const rawLines = [...headers, "", params.bodyText];
  const raw = encodeRawRfc2822(rawLines);

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  const messageId = res.data.id;
  const threadId = res.data.threadId;
  if (!messageId || !threadId) {
    throw new Error("Gmail send response missing id or threadId");
  }

  return { messageId, threadId };
}
