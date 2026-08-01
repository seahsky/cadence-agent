import type { Platform } from "./platform.js";

/**
 * The level a fact is remembered at.
 *
 * Three levels, from [ADR 0002](../../docs/adr/0002-memory-scope.md). A fact defaults to `user`, so
 * the private level is the default and the shared levels are a deliberate act. Reads union across
 * every applicable level; writes go to exactly one, and no level supersedes another.
 *
 * There is no schema here, unlike {@link Origin}. A scope is resolved from an origin by cadence's
 * own code and never arrives from outside, so there is no boundary for one to guard.
 */
export type Scope =
  | { readonly kind: "user"; readonly platform: Platform; readonly userId: string }
  | { readonly kind: "channel"; readonly platform: Platform; readonly channelId: string }
  | { readonly kind: "guild"; readonly platform: Platform; readonly guildId: string };

/**
 * Bumped only if the key layout changes. Present so it can be, which is the whole reason a
 * serialised key carries a version segment at all.
 */
export const SCOPE_KEY_VERSION = "v1";

/**
 * The storage and index representation of a scope: `cadence:v1:discord:user:1234`.
 *
 * The union and the string answer different questions rather than competing. A string is a good
 * index key and a bad type — it offers no exhaustiveness, and building a wrong key by concatenation
 * is the easiest mistake available — so this is the one function allowed to build one, and every
 * call site upstream switches on the union instead.
 */
export const scopeKey = (scope: Scope): string => {
  const prefix = `cadence:${SCOPE_KEY_VERSION}:${scope.platform}`;

  switch (scope.kind) {
    case "user":
      return `${prefix}:user:${scope.userId}`;
    case "channel":
      return `${prefix}:channel:${scope.channelId}`;
    case "guild":
      return `${prefix}:guild:${scope.guildId}`;
  }
};
