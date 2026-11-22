import { describe, expect, test } from "bun:test";

import { parsePlainEnv, plainEnvSchema } from "../src/env.plain";

const required = {
  CORS_ORIGIN: "http://localhost:3001",
  DATABASE_URL: "file:data/buncrawl.db",
  BUNCRAWL_ARTIFACTS_PATH: "data/artifacts",
};

/** The variables .env.schema declares, whether each is required, and whether it has a default. */
async function schemaItems(): Promise<{ key: string; required: boolean; hasDefault: boolean }[]> {
  const lines = (await Bun.file(new URL("../.env.schema", import.meta.url)).text()).split("\n");
  const items: { key: string; required: boolean; hasDefault: boolean }[] = [];
  let decorators = "";
  for (const line of lines) {
    if (line.startsWith("#")) {
      decorators += line;
      continue;
    }
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) {
      items.push({
        key: match[1]!,
        required: !decorators.includes("@required=false"),
        hasDefault: match[2] !== "",
      });
    }
    decorators = "";
  }
  return items;
}

describe("parsePlainEnv", () => {
  test("covers every variable in .env.schema with the same requirement", async () => {
    const items = await schemaItems();
    expect(Object.keys(plainEnvSchema.entries).sort()).toEqual(
      items.map((item) => item.key).sort(),
    );
    for (const item of items) {
      const optional = plainEnvSchema.entries[item.key as keyof typeof plainEnvSchema.entries].type;
      // Schema defaults are development paths, so the executable may require those instead.
      if (!item.required) expect([item.key, optional]).toEqual([item.key, "optional"]);
      if (item.required && !item.hasDefault)
        expect([item.key, optional]).not.toEqual([item.key, "optional"]);
    }
  });

  test("reads plain variables, treating empty values as unset", () => {
    const env = parsePlainEnv({
      ...required,
      BUNCRAWL_R2_BUCKET: "",
      BUNCRAWL_CHROME_NO_SANDBOX: "1",
      UNRELATED: "ignored",
    });
    expect(env).toEqual({ NODE_ENV: "production", ...required, BUNCRAWL_CHROME_NO_SANDBOX: true });
  });

  test("names missing and invalid variables without echoing values", () => {
    expect(() =>
      parsePlainEnv({ ...required, CORS_ORIGIN: "not a url", DATABASE_URL: undefined }),
    ).toThrow(/CORS_ORIGIN[\s\S]*DATABASE_URL/);
    expect(() => parsePlainEnv({ ...required, CORS_ORIGIN: "secret-ish" })).not.toThrow(
      /secret-ish/,
    );
  });
});
