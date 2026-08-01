import { z } from "zod";
import { EntryIdSchema, NativeIdSchema, type Origin, OriginSchema } from "../domain/index.js";
import {
  type ForgetArgs,
  type PurgeArgs,
  parseCommandInvocation,
  type RedactArgs,
} from "./commands.js";

/**
 * What arrives from a communication surface: an entry, or an owner command.
 *
 * One rule for the whole set, from [ADR 0007](../../docs/adr/0007-channel-abstraction.md): a field
 * belongs in the shape only if the agent's answer would change because of it. That is why there is
 * no `threadId` here and no `isEdit` — the adapter has already resolved both into a fork point.
 */
export type Inbound = InboundEntry | InboundCommand;

/**
 * Metadata for a file someone attached. Not bytes, and not a URL.
 *
 * Bytes would give a transport a second job, since attachment bytes belong in the content-addressed
 * store outside both stores. A bare URL cannot cross the seam either: Discord's CDN links are
 * signed and expiring and a Slack file needs an auth header, so whoever fetched would need
 * per-platform knowledge. `ChannelAdapter.fetchAttachment` takes this back instead, which keeps
 * platform auth inside and blob storage outside.
 */
export const AttachmentRefSchema = z.object({
  /** Opaque to everything above the adapter, which is the only thing that can re-fetch with it. */
  id: z.string().min(1),
  filename: z.string().min(1),
  contentType: z.string().min(1).optional(),
  bytes: z.number().int().nonnegative(),
});

export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

/**
 * Whether this entry continues from its parent or supersedes it.
 *
 * Both gestures project as branches. A thread started on an entry continues from it; an edit forks
 * a revision at the superseded entry's *parent*, and the original path becomes a dead path —
 * retained so the record stays honest, never assembled into context.
 */
export const ForkSchema = z.enum(["continue", "revise"]);

export type Fork = z.infer<typeof ForkSchema>;

export const InboundEntrySchema = z.object({
  kind: z.literal("entry"),

  origin: OriginSchema,

  fork: ForkSchema,

  /** Already resolved by the adapter. `null` only for the first entry in a channel's trunk. */
  parentEntryId: EntryIdSchema.nullable(),

  /** Plural for the same reason `EntryIds.bind` takes a list: one entry, many native artifacts. */
  nativeIds: z.array(NativeIdSchema).min(1),

  at: z.date(),

  /** Mention-resolved: `<@1234>` has already become a display name, which is what a model can read. */
  text: z.string(),

  /**
   * The ids the mention resolution replaced, kept so nothing has to parse them back out of the text.
   * Empty is the common case, so it defaults rather than being optional in the type.
   */
  mentions: z.array(z.string().min(1)).default([]),

  /**
   * A pointer to an earlier entry this one refers to, carrying no structural meaning.
   *
   * A plain reply is not a fork point. If it set `parentEntryId`, every casual reply would fork the
   * tree and the projection would stop meaning anything, so a reply to something other than the
   * preceding entry lands here: a hint the agent may use, structurally inert.
   */
  quotes: EntryIdSchema.optional(),

  attachments: z.array(AttachmentRefSchema).default([]),
});

export type InboundEntry = z.infer<typeof InboundEntrySchema>;

/**
 * Parse an inbound entry.
 *
 * An inbound is external data, so it is validated rather than trusted, and the adapter is where the
 * validating happens. Throws with a readable message: a malformed inbound is a bug in the adapter's
 * projection, not something to route to the agent and let it puzzle over.
 */
export const parseInboundEntry = (raw: unknown): InboundEntry => {
  const result = InboundEntrySchema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Invalid inbound entry:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
};

/**
 * What cadence tells the owner about a command it ran, as values rather than rendered text, for the
 * same reason a {@link Notice} is.
 *
 * `forget` says the log survives, because saying "forgotten" and leaving the conversation
 * searchable would be a lie the storage layer cannot make true. `purge` and `redact` report counts
 * and never content.
 */
export type CommandResult =
  | { readonly kind: "forgotten"; readonly topic: string; readonly factsInvalidated: number }
  | {
      readonly kind: "destroyed";
      readonly topic: string;
      readonly factsDestroyed: number;
      readonly entriesTombstoned: number;
      readonly backupsAgeOutAt: Date;
    }
  /** Nothing matched. Distinct from success, because "done" over an empty match set reads as a lie. */
  | { readonly kind: "nothing-matched"; readonly topic: string }
  /** Refused: not the owner, or arguments that would not parse. */
  | { readonly kind: "refused"; readonly reason: string };

export type CommandEnvelope = {
  readonly kind: "command";
  readonly origin: Origin;
  readonly at: Date;

  /**
   * The one lifecycle call a command has.
   *
   * Ack-and-defer does not appear here: the adapter defers immediately and invisibly on receipt,
   * ephemerally, so a handler that spends a minute rewriting git history needs to know nothing. An
   * `ack()` in the interface would be a step every caller has to remember.
   */
  readonly respond: (result: CommandResult) => Promise<void>;
};

/**
 * An owner command, recognised before the agent loop sees it.
 *
 * Written as an explicit union rather than an envelope intersected with an invocation, so narrowing
 * on `name` gives the right `args` at every call site.
 */
export type InboundCommand =
  | (CommandEnvelope & { readonly name: "forget"; readonly args: ForgetArgs })
  | (CommandEnvelope & { readonly name: "purge"; readonly args: PurgeArgs })
  | (CommandEnvelope & { readonly name: "redact"; readonly args: RedactArgs });

/**
 * Parse an owner command into the shape the runtime handles.
 *
 * The adapter supplies the envelope, because `respond` is a closure over a live interaction and the
 * name and arguments are the only external data. Throws on anything it cannot type, which the
 * adapter catches and answers with a `refused` result — a destructive command is not one to guess
 * the arguments of.
 */
export const parseInboundCommand = (
  envelope: CommandEnvelope,
  name: string,
  rawArgs: unknown,
): InboundCommand => {
  const invocation = parseCommandInvocation(name, rawArgs);

  switch (invocation.name) {
    case "forget":
      return { ...envelope, name: "forget", args: invocation.args };
    case "purge":
      return { ...envelope, name: "purge", args: invocation.args };
    case "redact":
      return { ...envelope, name: "redact", args: invocation.args };
  }
};
