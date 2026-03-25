import type { Request, Response } from "express";
import { getConfig } from "../config.js";
import { getSlackUserGmailByGoogleEmail } from "../db/repos.js";
import { processGmailAccountInboxDelta } from "../gmail/sync.js";

type PubSubPushBody = {
  message?: { data?: string; attributes?: Record<string, string> };
  subscription?: string;
};

export function pubsubGmailHandler(req: Request, res: Response): void {
  const cfg = getConfig();
  if (cfg.PUBSUB_PUSH_SECRET) {
    const hdr = req.header("x-pubsub-secret");
    if (hdr !== cfg.PUBSUB_PUSH_SECRET) {
      res.status(403).send("forbidden");
      return;
    }
  }

  void handlePubSub(req, res).catch((err) => {
    console.error("pubsub handler error", err);
    if (!res.headersSent) res.status(500).send("error");
  });
}

async function handlePubSub(req: Request, res: Response): Promise<void> {
  const body = req.body as PubSubPushBody;
  const dataB64 = body.message?.data;
  if (!dataB64) {
    res.status(400).send("no data");
    return;
  }
  let payload: { emailAddress?: string; historyId?: string };
  try {
    payload = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8")) as {
      emailAddress?: string;
      historyId?: string;
    };
  } catch {
    res.status(400).send("bad json");
    return;
  }

  const email = payload.emailAddress;
  if (!email) {
    res.status(400).send("no email");
    return;
  }

  res.status(204).send();

  const account = await getSlackUserGmailByGoogleEmail(email);
  if (!account) {
    console.warn("Pub/Sub for unknown Gmail account", email);
    return;
  }

  await processGmailAccountInboxDelta(account);
}
