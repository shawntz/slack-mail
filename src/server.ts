import express from "express";
import slackBolt from "@slack/bolt";

const { App, ExpressReceiver } = slackBolt;
import { getConfig } from "./config.js";
import {
  deleteExpiredOAuthStates,
  decryptGoogleRefreshToken,
  getWorkspaceById,
  listGmailAccountsNeedingWatchRenewal,
} from "./db/repos.js";
import { runMigrations } from "./db/runMigrations.js";
import { createGmailForRefresh } from "./gmail/client.js";
import { registerMailboxWatch } from "./gmail/watch.js";
import { mountGoogleOAuthRoutes } from "./routes/oauthGoogle.js";
import { pubsubGmailHandler } from "./routes/pubsub.js";
import { registerSlackHandlers } from "./slack/boltApp.js";
import { createPgInstallationStore } from "./slack/installationStore.js";

const BOT_SCOPES = [
  "channels:history",
  "groups:history",
  "groups:write",
  "chat:write",
  "commands",
  "users:read",
];

async function main(): Promise<void> {
  const cfg = getConfig();
  await runMigrations();

  const installationStore = createPgInstallationStore();
  const redirectUri = `${cfg.APP_BASE_URL.replace(/\/$/, "")}/slack/oauth_redirect`;
  const redirectUriPath = new URL(redirectUri).pathname;

  const receiver = new ExpressReceiver({
    signingSecret: cfg.SLACK_SIGNING_SECRET,
    clientId: cfg.SLACK_CLIENT_ID,
    clientSecret: cfg.SLACK_CLIENT_SECRET,
    stateSecret: cfg.SLACK_STATE_SECRET,
    installationStore,
    scopes: BOT_SCOPES,
    processBeforeResponse: true,
    installerOptions: {
      directInstall: true,
      redirectUriPath,
    },
    redirectUri,
  });

  receiver.app.use(express.json({ limit: "4mb" }));
  receiver.app.get("/health", (_req, res) => {
    res.status(200).send("ok");
  });
  mountGoogleOAuthRoutes(receiver.app);
  receiver.app.post("/webhooks/gmail-pubsub", pubsubGmailHandler);

  const app = new App({
    receiver,
    installationStore,
    ignoreSelf: true,
  });

  registerSlackHandlers(app);

  const renewWatches = async (): Promise<void> => {
    await deleteExpiredOAuthStates();
    const horizon = 48 * 60 * 60 * 1000;
    const due = await listGmailAccountsNeedingWatchRenewal(horizon);
    for (const acc of due) {
      const ws = await getWorkspaceById(acc.workspace_id);
      if (!ws) continue;
      try {
        const gmail = createGmailForRefresh(decryptGoogleRefreshToken(acc));
        await registerMailboxWatch(gmail, acc.id);
      } catch (e) {
        console.error("watch renewal failed for account", acc.id, e);
      }
    }
  };

  setInterval(() => {
    void renewWatches().catch((e) => console.error("renewWatches", e));
  }, 6 * 60 * 60 * 1000);

  setTimeout(() => {
    void renewWatches().catch((e) => console.error("renewWatches initial", e));
  }, 10_000);

  await app.start(cfg.PORT);
  console.log(`Slacker Mail listening on :${cfg.PORT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
