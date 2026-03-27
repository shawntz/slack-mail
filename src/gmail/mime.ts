import type { gmail_v1 } from "googleapis";

function decodeBody(data?: string | null): string {
  if (!data) return "";
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function walkParts(
  payload: gmail_v1.Schema$MessagePart | undefined,
  visit: (p: gmail_v1.Schema$MessagePart) => void,
): void {
  if (!payload) return;
  visit(payload);
  for (const p of payload.parts ?? []) {
    walkParts(p, visit);
  }
}

export function extractPlainText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  let html = "";
  let plain = "";
  walkParts(payload, (p) => {
    const mime = p.mimeType ?? "";
    const body = p.body?.data;
    if (mime === "text/plain" && body) plain += decodeBody(body);
    if (mime === "text/html" && body) html += decodeBody(body);
  });
  if (plain.trim()) return plain.trim();
  if (html.trim()) return stripHtml(html);
  return "";
}

export type AttachmentMeta = {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
};

export function extractAttachments(payload: gmail_v1.Schema$MessagePart | undefined): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];
  walkParts(payload, (p) => {
    const filename = p.filename;
    const attachmentId = p.body?.attachmentId;
    if (filename && attachmentId) {
      attachments.push({
        filename,
        mimeType: p.mimeType ?? "application/octet-stream",
        attachmentId,
        size: p.body?.size ?? 0,
      });
    }
  });
  return attachments;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function headerMap(
  headers: gmail_v1.Schema$MessagePart["headers"] | undefined,
): Record<string, string> {
  const m: Record<string, string> = {};
  for (const h of headers ?? []) {
    const name = h.name?.toLowerCase();
    if (name && h.value) m[name] = h.value;
  }
  return m;
}

export function getHeader(
  headers: gmail_v1.Schema$MessagePart["headers"] | undefined,
  name: string,
): string {
  return headerMap(headers)[name.toLowerCase()] ?? "";
}

/** Display name + email for Slack mrkdwn when the From header includes a phrase address. */
export function formatFromForSlack(fromHeader: string): string {
  const raw = fromHeader.trim();
  if (!raw || raw === "(unknown)") return "(unknown)";

  const m = raw.match(/^(.*?)\s*<([^>]+@[^>]+)>\s*$/);
  if (m) {
    const namePart = m[1]!.replace(/^["']|["']$/g, "").trim();
    const email = m[2]!.trim();
    const nameLooksLikeEmail = /^[^\s@]+@[^\s@]+$/.test(namePart);
    if (namePart && !nameLooksLikeEmail) {
      const safe = namePart.replace(/\*/g, "·");
      return `*${safe}* \`${email}\``;
    }
    return `\`${email}\``;
  }

  if (/^[^\s@]+@[^\s@]+$/.test(raw)) return `\`${raw}\``;
  return raw.replace(/\*/g, "·");
}
