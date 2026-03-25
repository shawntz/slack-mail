import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { getConfig } from "../config.js";
import { createGmailForRefresh, createOAuth2Client } from "../gmail/client.js";
import { registerMailboxWatch } from "../gmail/watch.js";
import {
  consumeOAuthState,
  createOAuthState,
  getWorkspaceById,
  upsertSlackUserGmail,
} from "../db/repos.js";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

export function mountGoogleOAuthRoutes(
  app: import("express").Application,
): void {
  app.get("/oauth/google/start", (req: Request, res: Response) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!state) {
      res.status(400).send("Missing state");
      return;
    }
    const oauth2 = createOAuth2Client();
    const url = oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GMAIL_SCOPES,
      state,
    });
    res.redirect(url);
  });

  app.get("/oauth/google/callback", (req: Request, res: Response) => {
    void handleGoogleCallback(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) res.status(500).send("OAuth error");
    });
  });
}

async function handleGoogleCallback(req: Request, res: Response): Promise<void> {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code || !state) {
    res.status(400).send("Missing code or state");
    return;
  }

  const consumed = await consumeOAuthState(state);
  if (!consumed) {
    res.status(400).send("Invalid or expired state");
    return;
  }

  const ws = await getWorkspaceById(consumed.workspaceId);
  if (!ws) {
    res.status(400).send("Workspace not found");
    return;
  }

  const oauth2 = createOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    res
      .status(400)
      .send("No refresh token returned. Revoke app access in Google and try again with prompt=consent.");
    return;
  }

  oauth2.setCredentials(tokens);
  const gmail = createGmailForRefresh(tokens.refresh_token);
  const prof = await gmail.users.getProfile({ userId: "me" });
  const email = prof.data.emailAddress ?? "";
  const historyId = prof.data.historyId ?? null;

  const row = await upsertSlackUserGmail({
    workspaceId: consumed.workspaceId,
    slackUserId: consumed.slackUserId,
    googleEmail: email,
    refreshToken: tokens.refresh_token,
    historyId,
  });

  await registerMailboxWatch(gmail, row.id);

  res
    .status(200)
    .send(
      `<html><body><p>Gmail linked as <b>${email}</b>. You can close this tab.</p></body></html>`,
    );
}

export async function createGoogleLinkState(
  workspaceId: number,
  slackUserId: string,
): Promise<string> {
  const token = randomBytes(24).toString("hex");
  await createOAuthState({
    stateToken: token,
    workspaceId,
    slackUserId,
    ttlSeconds: 600,
  });
  return token;
}

export function googleLinkUrl(stateToken: string): string {
  const base = getConfig().APP_BASE_URL;
  return `${base}/oauth/google/start?state=${encodeURIComponent(stateToken)}`;
}
