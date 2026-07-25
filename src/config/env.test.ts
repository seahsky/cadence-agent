import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

describe("parseEnv", () => {
  it("applies defaults when optional vars are absent", () => {
    const env = parseEnv({});

    expect(env.CLAUDE_CLI_PATH).toBe("claude");
    expect(env.DATA_DIR).toBe("./data");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.NODE_ENV).toBe("development");
  });

  it("keeps supplied values", () => {
    const env = parseEnv({ LOG_LEVEL: "debug", DATA_DIR: "/srv/cadence" });

    expect(env.LOG_LEVEL).toBe("debug");
    expect(env.DATA_DIR).toBe("/srv/cadence");
  });

  it("rejects a value outside the allowed set, naming the offending key", () => {
    expect(() => parseEnv({ LOG_LEVEL: "verbose" })).toThrowError(/LOG_LEVEL/);
  });

  it("rejects an empty string where a non-empty one is required", () => {
    expect(() => parseEnv({ OPENROUTER_API_KEY: "" })).toThrowError(/OPENROUTER_API_KEY/);
  });

  it("does not mutate the source it is handed", () => {
    const source = { LOG_LEVEL: "warn" } as const;
    parseEnv(source);

    expect(source).toEqual({ LOG_LEVEL: "warn" });
  });
});
