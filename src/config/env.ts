import { z } from "zod";

/**
 * Everything cadence reads from the environment, validated at startup.
 *
 * Presence is deliberately *not* enforced for credentials nothing consumes yet: requiring
 * DISCORD_BOT_TOKEN before any Discord code exists would just stop `pnpm dev` from running.
 * Each channel and provider tightens its own slice when its code lands.
 */
const EnvSchema = z.object({
  /** Bot token from the Discord developer portal. Required once the Discord channel exists. */
  DISCORD_BOT_TOKEN: z.string().min(1).optional(),

  /** OpenRouter key, for the per-token HTTP provider. */
  OPENROUTER_API_KEY: z.string().min(1).optional(),

  /** How to invoke Claude Code headlessly. A bare `claude` resolves via PATH. */
  CLAUDE_CLI_PATH: z.string().min(1).default("claude"),

  /** Root for anything cadence persists — sessions, memory, logs. */
  DATA_DIR: z.string().min(1).default("./data"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

type Issue = z.ZodError["issues"][number];

const describePath = (path: Issue["path"]): string =>
  path.length > 0 ? path.map(String).join(".") : "(root)";

const formatIssues = (issues: readonly Issue[]): string =>
  issues.map((issue) => `  ${describePath(issue.path)}: ${issue.message}`).join("\n");

/**
 * Parse and validate the environment.
 *
 * Takes the source as a parameter rather than reaching for `process.env` internally, so the
 * function stays pure and testable. Throws rather than returning a partial config: a
 * misconfigured agent should fail at boot with a readable message, not halfway through
 * answering someone.
 */
export const parseEnv = (source: Record<string, string | undefined> = process.env): Env => {
  const result = EnvSchema.safeParse(source);

  if (!result.success) {
    throw new Error(`Invalid environment:\n${formatIssues(result.error.issues)}`);
  }

  return result.data;
};
