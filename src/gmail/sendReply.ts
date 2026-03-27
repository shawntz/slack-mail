import { randomBytes } from "node:crypto";
import { createGmailForRefresh } from "./client.js";
import { getHeader } from "./mime.js";
import { decryptGoogleRefreshToken } from "../db/repos.js";
import type { SlackUserGmailRow } from "../db/repos.js";

function extractEmail(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  if (m) return m[1]!.trim();
  return fromHeader.trim();
}

function encodeRawRfc2822(lines: string[]): string {
  const raw = lines.join("\r\n");
  return Buffer.from(raw, "utf8").toString("base64url");
}

export type ReplyAttachment = {
  filename: string;
  mimeType: string;
  content: Buffer;
};

function randomBoundary(): string {
  return `----=_Part_${randomBytes(16).toString("hex")}`;
}

function buildMultipartRaw(params: {
  headers: string[];
  bodyText: string;
  files: ReplyAttachment[];
}): string {
  const boundary = randomBoundary();
  const headerLines = [
    ...params.headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
  ];

  const parts: string[] = [];

  // Text part
  parts.push(
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    params.bodyText,
  );

  // Attachment parts
  for (const file of params.files) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${file.mimeType}; name="${file.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${file.filename}"`,
      "",
      file.content.toString("base64"),
    );
  }

  parts.push(`--${boundary}--`);

  const raw = headerLines.join("\r\n") + "\r\n" + parts.join("\r\n") + "\r\n";
  return Buffer.from(raw, "utf8").toString("base64url");
}

export async function sendGmailReplyFromSlack(params: {
  account: SlackUserGmailRow;
  gmailThreadId: string;
  userEmail: string;
  bodyText: string;
  files?: ReplyAttachment[];
}): Promise<void> {
  const gmail = createGmailForRefresh(decryptGoogleRefreshToken(params.account));
  const thread = await gmail.users.threads.get({
    userId: "me",
    id: params.gmailThreadId,
    format: "full",
  });
  const messages = [...(thread.data.messages ?? [])].sort(
    (a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0),
  );

  let replyTo = "";
  let subject = "";
  let inReplyTo = "";
  let references = "";

  const userAddr = params.userEmail.toLowerCase();

  for (const m of messages) {
    const headers = m.payload?.headers;
    const from = getHeader(headers, "From");
    const fromAddr = extractEmail(from).toLowerCase();
    const subj = getHeader(headers, "Subject");
    const mid = getHeader(headers, "Message-ID");
    if (!replyTo && fromAddr && fromAddr !== userAddr) {
      replyTo = extractEmail(from);
      subject = subj?.startsWith("Re:") ? subj : `Re: ${subj || ""}`.trim();
      inReplyTo = mid;
      const prevRefs = getHeader(headers, "References");
      references = prevRefs ? `${prevRefs} ${mid}`.trim() : mid;
      break;
    }
  }

  if (!replyTo && messages.length) {
    const last = messages[0]!;
    const headers = last.payload?.headers;
    replyTo = extractEmail(getHeader(headers, "From") || getHeader(headers, "To"));
    subject = getHeader(headers, "Subject") || "Re:";
    if (!subject.toLowerCase().startsWith("re:")) subject = `Re: ${subject}`;
    inReplyTo = getHeader(headers, "Message-ID");
    references = getHeader(headers, "References") || inReplyTo;
  }

  if (!replyTo) {
    throw new Error("Could not determine reply recipient for thread");
  }

  // Fetch display name from Gmail send-as settings
  let fromHeader = params.userEmail;
  try {
    const sendAs = await gmail.users.settings.sendAs.list({ userId: "me" });
    const primary = sendAs.data.sendAs?.find((s) => s.isPrimary);
    if (primary?.displayName) {
      fromHeader = `"${primary.displayName}" <${params.userEmail}>`;
    }
  } catch {
    // Fall back to bare email if we can't fetch the display name
  }

  const commonHeaders = [
    `From: ${fromHeader}`,
    `To: ${replyTo}`,
    `Subject: ${subject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references}`,
  ];

  let raw: string;
  if (params.files && params.files.length > 0) {
    raw = buildMultipartRaw({
      headers: commonHeaders,
      bodyText: params.bodyText,
      files: params.files,
    });
  } else {
    const rawLines = [
      ...commonHeaders,
      "Content-Type: text/plain; charset=utf-8",
      "",
      params.bodyText,
    ];
    raw = encodeRawRfc2822(rawLines);
  }

  await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      threadId: params.gmailThreadId,
      raw,
    },
  });
}
