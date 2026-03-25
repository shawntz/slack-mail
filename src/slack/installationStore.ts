import type { Logger } from "@slack/logger";
import type { Installation, InstallationQuery, InstallationStore } from "@slack/oauth";
import { decryptBotToken, getWorkspaceBySlackTeamId, upsertWorkspace } from "../db/repos.js";

export function createPgInstallationStore(): InstallationStore {
  return {
    async storeInstallation<AuthVersion extends "v1" | "v2">(
      installation: Installation<AuthVersion, boolean>,
      _logger?: Logger,
    ): Promise<void> {
      const teamId = installation.team?.id;
      const bot = installation.bot;
      if (!teamId || !bot?.token || !bot.userId) {
        throw new Error("Installation missing team or bot credentials");
      }
      await upsertWorkspace({
        slackTeamId: teamId,
        teamName: installation.team?.name ?? null,
        botToken: bot.token,
        botUserId: bot.userId,
      });
    },

    async fetchInstallation(
      query: InstallationQuery<boolean>,
      _logger?: Logger,
    ): Promise<Installation<"v1" | "v2", boolean>> {
      if (query.isEnterpriseInstall) {
        throw new Error("Enterprise installs are not supported");
      }
      const teamId = query.teamId;
      if (!teamId) throw new Error("Missing teamId in installation query");

      const row = await getWorkspaceBySlackTeamId(teamId);
      if (!row) throw new Error(`No installation for team ${teamId}`);

      const botToken = decryptBotToken(row);
      const installation: Installation<"v2", false> = {
        team: { id: row.slack_team_id, name: row.team_name ?? undefined },
        enterprise: undefined,
        user: {
          id: query.userId ?? "unknown",
          token: undefined,
          scopes: undefined,
        },
        bot: {
          id: row.bot_user_id,
          userId: row.bot_user_id,
          token: botToken,
          scopes: [],
        },
        isEnterpriseInstall: false as const,
        authVersion: "v2",
        tokenType: "bot",
      };
      return installation;
    },

    async deleteInstallation(query: InstallationQuery<boolean>, _logger?: Logger): Promise<void> {
      // Optional: implement workspace uninstall
      void query;
    },
  };
}
