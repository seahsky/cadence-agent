import type { EntryId, NativeId, Platform } from "../domain/index.js";
import type { AttachmentRef, Inbound } from "./inbound.js";
import type { Notify } from "./ports.js";

/**
 * Where a reply goes, and what to record it as.
 *
 * Two entry ids and nothing else. The destination is deliberately absent: an entry that arrived in
 * a thread must be answered in that thread, while `origin.channelId` is always the trunk, so
 * carrying an origin here would hand the adapter an id that is wrong exactly when it matters. The
 * adapter resolves `inReplyTo` through `EntryIds.toNative` instead, and a miss is a failed send
 * reported on the operator port rather than a reply posted in the wrong place.
 */
export type ReplyTarget = {
  /** The id cadence has assigned to the reply, so the adapter can bind what it produces. */
  readonly entryId: EntryId;

  /** The entry being answered. Resolves to a native location, thread included. */
  readonly inReplyTo: EntryId;
};

/**
 * Thrown when a surface cannot perform an operation at all.
 *
 * There are no capability declarations to check first: a flag nothing branches on exists only to be
 * logged, and asking what the agent would do with `supportsStreaming: false` has no answer. So the
 * operation throws, and for a model-invoked action such as `branch` on a CLI the throw becomes a
 * tool error the model reads and works around. Adaptation without negotiation.
 */
export class UnsupportedOperation extends Error {
  constructor(platform: Platform, operation: string) {
    super(`${platform} cannot ${operation}`);
    this.name = "UnsupportedOperation";
  }
}

/**
 * One platform's connection, and the projection of its native gestures onto the entry tree.
 *
 * An adapter is not a transport and not a channel. It is one per platform, serving every
 * destination on it, and it is the only place a platform primitive is allowed to appear: the word
 * "thread" never occurs above `src/channel/<platform>/`.
 *
 * Constructed as `createDiscordChannel({ entryIds, editJudge, config })`. It receives its ports and
 * imports neither `src/storage` nor `src/provider`.
 */
export type ChannelAdapter = {
  readonly platform: Platform;

  readonly start: () => Promise<void>;

  readonly stop: () => Promise<void>;

  /**
   * A **bounded** buffer with a stated overflow policy, not an unbounded queue: the gateway pushes
   * whether cadence is ready or not, and an unbounded one turns a slow turn into a memory leak.
   * Overflow is reported on {@link notify}.
   */
  readonly inbound: () => AsyncIterable<Inbound>;

  /**
   * The channel pulls text deltas until exhaustion, rather than being handed a push/finish handle.
   *
   * That is what makes the typing indicator's `finally` impossible to forget, and it makes
   * cancellation compose for free, since aborting the iterable ends the `for await` and settles the
   * partial reply. A surface that cannot stream drains the iterable and emits once.
   *
   * The payload is text and nothing else. Chunking, dialect downconversion and rendering an
   * interruption are all the adapter's, because only the surface knows how to say "this broke" in
   * its own idiom.
   *
   * Returns every native id it produced, because chunking at the platform's character limit means
   * one turn lands as several messages, and a revision has to be able to clean up after itself.
   */
  readonly reply: (at: ReplyTarget, deltas: AsyncIterable<string>) => Promise<readonly NativeId[]>;

  /** Throws {@link UnsupportedOperation} where the surface has no branching primitive. */
  readonly branch: (from: EntryId, title: string) => Promise<EntryId>;

  /** Platform auth stays inside; the bytes go to the content-addressed store outside both stores. */
  readonly fetchAttachment: (ref: AttachmentRef) => Promise<ReadableStream<Uint8Array>>;

  /** Bound to a configured destination that holds no entry tree and is never read back. */
  readonly notify: Notify;
};
