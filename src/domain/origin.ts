import { z } from "zod";
import { PLATFORMS } from "./platform.js";

/**
 * The native identifiers an inbound arrives with.
 *
 * What a scope is resolved from, and never a scope itself. A transport that constructs scopes is a
 * transport that can construct the wrong one, against
 * [ADR 0002](../../docs/adr/0002-memory-scope.md)'s bar that scope be a function the call site
 * cannot bypass. So this carries ids and `resolveScope` turns them into scopes.
 *
 * It is parsed rather than assumed because an inbound is external data, and the adapter builds this
 * from whatever the platform handed it.
 */
export const OriginSchema = z.object({
  platform: z.enum(PLATFORMS),

  /** The person who said it. Native to the platform; cadence has no identity of its own yet. */
  userId: z.string().min(1),

  /**
   * **Always the trunk channel id, never the thread id**, including for an entry that arrived in a
   * thread. [ADR 0001](../../docs/adr/0001-one-entry-tree-per-channel.md) makes this the scope key
   * and [ADR 0005](../../docs/adr/0005-storage.md) fixes an episodic entry's scope to the trunk.
   * The adapter is the only thing that knows a thread's trunk, so it is the only thing that can
   * honour this, and a thread id must not be constructible into a scope anywhere in the system.
   */
  channelId: z.string().min(1),

  /** Absent on a surface with no guild concept, which simply has no guild scope to read. */
  guildId: z.string().min(1).optional(),
});

export type Origin = z.infer<typeof OriginSchema>;
