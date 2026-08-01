import type { EntryId, NativeId } from "../domain/index.js";
import type { Notice } from "./notice.js";

/**
 * The adapter's entire outside world: three narrow, function-shaped ports injected at a composition
 * root. A test drives an adapter with three fakes and no database, no model and no gateway.
 *
 * They exist because owning the projection means needing things the adapter must not import.
 */

/**
 * The native-id table, both directions.
 *
 * Importing `src/storage` instead would put a database handle in the channel layer and kill
 * [ADR 0002](../../docs/adr/0002-memory-scope.md)'s rule that the handle is module-private and
 * reachable only through a resolved scope.
 */
export type EntryIds = {
  /** Resolving a fork point is a native-id lookup: which entry is this message? */
  readonly toEntry: (native: NativeId) => Promise<EntryId | null>;

  /**
   * Where to put a reply, and what to start a thread on.
   *
   * [ADR 0007](../../docs/adr/0007-channel-abstraction.md) writes this port with `toEntry` and
   * `bind` only, which leaves `branch(from: EntryId, …)` with no way to find the message it is
   * meant to branch from. Same table, read the other way.
   *
   * Empty when the entry has no surviving native artifacts — purged, or never sent.
   */
  readonly toNative: (entry: EntryId) => Promise<readonly NativeId[]>;

  /** A reply writes one entry to many native ids, because chunking splits it. */
  readonly bind: (entry: EntryId, native: readonly NativeId[]) => Promise<void>;
};

export type EditVerdict = "material" | "cosmetic";

/**
 * Did this edit change what was meant?
 *
 * A cheap model call, because no edit-distance heuristic separates `teh` → `the` from `don't` →
 * `do`. Importing `src/provider` instead would leak
 * [ADR 0006](../../docs/adr/0006-model-routing.md)'s routing policy sideways into a transport.
 *
 * The rejected alternative was emitting a raw edit event and deciding above, then calling back to
 * create the thread: that splits one decision across the seam, in the single case where doing so is
 * least defensible.
 */
export type EditJudge = (before: string, after: string) => Promise<EditVerdict>;

/**
 * The operator surface, as one function.
 *
 * A field on the adapter rather than a method, so the composition root hands `adapter.notify` to
 * storage and there is no general-purpose `send` for anything to reach for. It is what keeps
 * [ADR 0005](../../docs/adr/0005-storage.md)'s "a memory failure is never swallowed" from dragging
 * Discord into `src/storage`.
 */
export type Notify = (notice: Notice) => Promise<void>;
