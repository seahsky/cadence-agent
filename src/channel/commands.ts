import { z } from "zod";

/**
 * The owner command set: the domain's declaration of what `forget`, `purge` and `redact` take, which
 * each adapter registers in whatever native mechanism it has.
 *
 * Declaring them here rather than per adapter is what makes Slack a translation rather than a
 * reimplementation. Discord turns this list into slash-command registration at boot and validates
 * inbound arguments against it before emitting.
 *
 * A command is not a tool call. [ADR 0004](../../docs/adr/0004-memory-layers.md) requires these to
 * be recognised before the agent loop sees them, because routing a destructive operation through
 * the model fires it on the model's reading of intent.
 */

export const COMMAND_NAMES = ["forget", "purge", "redact"] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export const CommandNameSchema = z.enum(COMMAND_NAMES);

/**
 * What to act on, as the owner would say it. Not a fact key: the owner does not know the keys, and
 * `src` provenance is what turns a topic into the entries a purge has to destroy.
 */
const TopicSchema = z.string().trim().min(1).max(200);

const ForgetArgsSchema = z.object({ topic: TopicSchema });
const PurgeArgsSchema = z.object({ topic: TopicSchema });
const RedactArgsSchema = z.object({ topic: TopicSchema });

export type ForgetArgs = z.infer<typeof ForgetArgsSchema>;
export type PurgeArgs = z.infer<typeof PurgeArgsSchema>;
export type RedactArgs = z.infer<typeof RedactArgsSchema>;

/** One parameter of a command, in the shape an adapter needs to register it. */
export type CommandParameter = {
  readonly name: string;
  readonly description: string;
  /** Only strings so far. A discriminant so an adapter's registration switch stays exhaustive. */
  readonly type: "string";
  readonly required: boolean;
};

export type CommandDescriptor = {
  readonly name: CommandName;
  /** Shown to the owner by the platform, so it is written for a person rather than for a log. */
  readonly description: string;
  readonly parameters: readonly CommandParameter[];
};

/**
 * Authorization sits in two places doing two different jobs: native permission gating at
 * registration, so these do not appear in other members' UI, and a real owner check above the
 * adapter, because who may destroy memory is policy and not transport.
 */
export const COMMANDS: readonly CommandDescriptor[] = [
  {
    name: "forget",
    description:
      "Stop believing something. The conversation stays in the log and stays searchable.",
    parameters: [
      { name: "topic", description: "What to stop believing.", type: "string", required: true },
    ],
  },
  {
    name: "purge",
    description: "Destroy a belief and the messages it came from. Cannot be undone.",
    parameters: [
      { name: "topic", description: "What to destroy.", type: "string", required: true },
    ],
  },
  {
    name: "redact",
    description:
      "Destroy a credential that reached memory. Purge, for a secret the scrubber missed.",
    parameters: [
      { name: "topic", description: "What to destroy.", type: "string", required: true },
    ],
  },
];

/**
 * A command name paired with its arguments, discriminated so a handler switches once and gets the
 * right argument type for free.
 */
export type CommandInvocation =
  | { readonly name: "forget"; readonly args: ForgetArgs }
  | { readonly name: "purge"; readonly args: PurgeArgs }
  | { readonly name: "redact"; readonly args: RedactArgs };

const parseArgs = <T>(name: CommandName, schema: z.ZodType<T>, raw: unknown): T => {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Invalid arguments for /${name}:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
};

/**
 * Turn a name and a bag of raw option values into a typed invocation.
 *
 * The single validation point every adapter goes through, so no adapter re-decides what `purge`
 * takes. Throws on an unknown name or a bad argument rather than returning a partial value: the
 * adapter catches and answers the owner, and a destructive command that half-parsed is not one to
 * guess at.
 */
export const parseCommandInvocation = (name: string, raw: unknown): CommandInvocation => {
  const parsedName = CommandNameSchema.safeParse(name);

  if (!parsedName.success) {
    throw new Error(`Unknown command: ${name}`);
  }

  switch (parsedName.data) {
    case "forget":
      return { name: "forget", args: parseArgs("forget", ForgetArgsSchema, raw) };
    case "purge":
      return { name: "purge", args: parseArgs("purge", PurgeArgsSchema, raw) };
    case "redact":
      return { name: "redact", args: parseArgs("redact", RedactArgsSchema, raw) };
  }
};
