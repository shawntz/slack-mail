import type { gmail_v1 } from "googleapis";
import { getConfig } from "../config.js";
import { updateWatchExpiration } from "../db/repos.js";

export async function registerMailboxWatch(
  gmail: gmail_v1.Gmail,
  accountId: number,
): Promise<void> {
  const topic = getConfig().GOOGLE_PUBSUB_TOPIC;
  const res = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: topic,
      labelIds: ["INBOX"],
    },
  });
  const expMs = res.data.expiration ? Number(res.data.expiration) : 0;
  const exp = expMs ? new Date(expMs) : null;
  await updateWatchExpiration(accountId, exp);
}

export async function stopMailboxWatch(gmail: gmail_v1.Gmail): Promise<void> {
  try {
    await gmail.users.stop({ userId: "me" });
  } catch {
    /* ignore */
  }
}
