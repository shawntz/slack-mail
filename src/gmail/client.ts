import { google } from "googleapis";
import { getConfig } from "../config.js";

export function createOAuth2Client() {
  const cfg = getConfig();
  return new google.auth.OAuth2(
    cfg.GOOGLE_CLIENT_ID,
    cfg.GOOGLE_CLIENT_SECRET,
    `${cfg.APP_BASE_URL}/oauth/google/callback`,
  );
}

export function createGmailForRefresh(refreshToken: string) {
  const oauth2 = createOAuth2Client();
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth: oauth2 });
}
