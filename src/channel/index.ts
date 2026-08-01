/**
 * The channel seam: what every communication surface implements, and the ports it receives.
 *
 * Decided in [ADR 0007](../../docs/adr/0007-channel-abstraction.md). Nothing here imports a
 * platform library — the adapters do, under `src/channel/<platform>/`.
 */
export { type ChannelAdapter, type ReplyTarget, UnsupportedOperation } from "./adapter.js";
export {
  COMMAND_NAMES,
  COMMANDS,
  type CommandDescriptor,
  type CommandInvocation,
  type CommandName,
  CommandNameSchema,
  type CommandParameter,
  type ForgetArgs,
  type PurgeArgs,
  parseCommandInvocation,
  type RedactArgs,
} from "./commands.js";
export {
  type AttachmentRef,
  AttachmentRefSchema,
  type CommandEnvelope,
  type CommandResult,
  type Fork,
  ForkSchema,
  type Inbound,
  type InboundCommand,
  type InboundEntry,
  InboundEntrySchema,
  parseInboundCommand,
  parseInboundEntry,
} from "./inbound.js";
export type { BackgroundPass, Notice } from "./notice.js";
export type { EditJudge, EditVerdict, EntryIds, Notify } from "./ports.js";
