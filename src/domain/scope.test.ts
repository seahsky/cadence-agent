import { describe, expect, it } from "vitest";
import { type Scope, scopeKey } from "./scope.js";

describe("scopeKey", () => {
  it("serialises each level with its version and platform segments", () => {
    const cases: ReadonlyArray<readonly [Scope, string]> = [
      [{ kind: "user", platform: "discord", userId: "1234" }, "cadence:v1:discord:user:1234"],
      [
        { kind: "channel", platform: "discord", channelId: "9876" },
        "cadence:v1:discord:channel:9876",
      ],
      [{ kind: "guild", platform: "discord", guildId: "555" }, "cadence:v1:discord:guild:555"],
    ];

    for (const [scope, expected] of cases) {
      expect(scopeKey(scope)).toBe(expected);
    }
  });

  it("keeps the levels apart even when the ids collide", () => {
    const same = "1234";

    const keys = new Set([
      scopeKey({ kind: "user", platform: "discord", userId: same }),
      scopeKey({ kind: "channel", platform: "discord", channelId: same }),
      scopeKey({ kind: "guild", platform: "discord", guildId: same }),
    ]);

    expect(keys.size).toBe(3);
  });
});
