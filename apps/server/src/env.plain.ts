import * as v from "valibot";

import type { CoercedEnvSchema } from "./env";

const text = v.pipe(v.string(), v.minLength(1));
const url = v.pipe(v.string(), v.url());
const boolean = v.pipe(
  v.string(),
  v.toLowerCase(),
  v.picklist(["true", "false", "1", "0"]),
  v.transform((value) => value === "true" || value === "1"),
);

/**
 * The variables of .env.schema, read straight from the environment. The single-file executable
 * uses this instead of varlock, which resolves the schema through its CLI at startup and so needs
 * the schema file and the CLI next to the binary. Instead of the schema's development paths, data
 * defaults to a `data` folder in the working directory (`/data` in the Docker image).
 */
export const plainEnvSchema = v.object({
  NODE_ENV: v.optional(v.picklist(["development", "production", "test"]), "production"),
  CORS_ORIGIN: v.optional(text, "*"),
  DATABASE_URL: v.optional(text, "file:data/buncrawl.db"),
  BUNCRAWL_ARTIFACTS_PATH: v.optional(text, "data/artifacts"),
  BUNCRAWL_R2_ENDPOINT: v.optional(url),
  BUNCRAWL_R2_BUCKET: v.optional(text),
  BUNCRAWL_R2_ACCESS_KEY_ID: v.optional(text),
  BUNCRAWL_R2_SECRET_ACCESS_KEY: v.optional(text),
  BUNCRAWL_R2_REGION: v.optional(text),
  REDIS_URL: v.optional(url),
  BUNCRAWL_PROXY_URL: v.optional(url),
  BUNCRAWL_API_KEY: v.optional(v.pipe(v.string(), v.minLength(16))),
  BUNCRAWL_WEBHOOK_SECRET: v.optional(v.pipe(v.string(), v.minLength(16))),
  BUN_CHROME_PATH: v.optional(text),
  BUNCRAWL_LIGHTPANDA_PATH: v.optional(text),
  BUNCRAWL_CHROME_NO_SANDBOX: v.optional(boolean),
});

/** Validates the schema's variables; empty values count as unset, as they do for varlock. */
export function parsePlainEnv(env: Record<string, string | undefined>): Readonly<CoercedEnvSchema> {
  const input: Record<string, string> = {};
  for (const key of Object.keys(plainEnvSchema.entries)) {
    const value = env[key];
    if (value !== undefined && value !== "") input[key] = value;
  }
  const result = v.safeParse(plainEnvSchema, input);
  if (!result.success) {
    // valibot's messages quote the received value, which may be a secret.
    const problems = result.issues.map(
      (issue) =>
        `${v.getDotPath(issue) ?? "environment"}: ${issue.input === undefined ? "is required" : `fails the ${issue.type} check`}`,
    );
    throw new Error(`Invalid environment variables:\n  ${problems.join("\n  ")}`);
  }
  return result.output;
}
