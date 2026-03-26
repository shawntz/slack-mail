import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

/** Trim whitespace/newlines from env values (common when pasting into .env or hosting UIs). */
const t = z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string());

const schema = z.object({
  SLACK_CLIENT_ID: t.pipe(z.string().min(1)),
  SLACK_CLIENT_SECRET: t.pipe(z.string().min(1)),
  SLACK_SIGNING_SECRET: t.pipe(z.string().min(1)),
  SLACK_STATE_SECRET: t.pipe(z.string().min(16)),
  APP_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_PUBSUB_TOPIC: z.string().min(1),
  PUBSUB_PUSH_SECRET: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(msg)}`);
  }
  cached = parsed.data;
  return cached;
}
