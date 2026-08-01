import { describe, expect, it, vi } from "vitest";
import { EntryIdSchema, NativeIdSchema } from "../domain/index.js";
import {
  type CommandEnvelope,
  type CommandResult,
  parseInboundCommand,
  parseInboundEntry,
} from "./inbound.js";

const minimalEntry = {
  kind: "entry",
  origin: { platform: "discord", userId: "u1", channelId: "c1" },
  fork: "continue",
  parentEntryId: null,
  nativeIds: ["n1"],
  at: new Date("2026-08-01T00:00:00Z"),
  text: "hello",
};

describe("parseInboundEntry", () => {
  it("fills the optional collections so the parsed shape is total", () => {
    const entry = parseInboundEntry(minimalEntry);

    expect(entry.mentions).toEqual([]);
    expect(entry.attachments).toEqual([]);
    expect(entry.quotes).toBeUndefined();
  });

  it("keeps a quote pointer without touching the parent", () => {
    const entry = parseInboundEntry({
      ...minimalEntry,
      parentEntryId: "e-parent",
      quotes: "e-quoted",
    });

    expect(entry.parentEntryId).toBe(EntryIdSchema.parse("e-parent"));
    expect(entry.quotes).toBe(EntryIdSchema.parse("e-quoted"));
  });

  it("carries attachment metadata and no bytes", () => {
    const entry = parseInboundEntry({
      ...minimalEntry,
      attachments: [{ id: "a1", filename: "notes.md", contentType: "text/markdown", bytes: 42 }],
    });

    expect(entry.attachments).toHaveLength(1);
    expect(entry.attachments[0]?.filename).toBe("notes.md");
  });

  it("accepts an empty text, because an attachment-only message is a real entry", () => {
    expect(() => parseInboundEntry({ ...minimalEntry, text: "" })).not.toThrow();
  });

  it("rejects an entry with no native id, naming the field", () => {
    expect(() => parseInboundEntry({ ...minimalEntry, nativeIds: [] })).toThrow(/nativeIds/);
  });

  it("rejects an origin with no channel, naming the field", () => {
    expect(() =>
      parseInboundEntry({ ...minimalEntry, origin: { platform: "discord", userId: "u1" } }),
    ).toThrow(/channelId/);
  });

  it("rejects a platform it has no adapter for", () => {
    expect(() =>
      parseInboundEntry({
        ...minimalEntry,
        origin: { platform: "slack", userId: "u1", channelId: "c1" },
      }),
    ).toThrow(/platform/);
  });

  it("rejects a fork it does not recognise", () => {
    expect(() => parseInboundEntry({ ...minimalEntry, fork: "reply" })).toThrow(/fork/);
  });

  it("binds a reply's native ids as a list, because chunking produces several", () => {
    const entry = parseInboundEntry({ ...minimalEntry, nativeIds: ["n1", "n2"] });

    expect(entry.nativeIds).toEqual([NativeIdSchema.parse("n1"), NativeIdSchema.parse("n2")]);
  });
});

describe("parseInboundCommand", () => {
  const envelope = (respond: CommandEnvelope["respond"]): CommandEnvelope => ({
    kind: "command",
    origin: { platform: "discord", userId: "u1", channelId: "c1" },
    at: new Date("2026-08-01T00:00:00Z"),
    respond,
  });

  it("types the arguments against the command that was invoked", () => {
    const command = parseInboundCommand(envelope(vi.fn()), "purge", { topic: "  the api key  " });

    expect(command.name).toBe("purge");
    expect(command.args.topic).toBe("the api key");
  });

  it("narrows to the right argument type on the name", () => {
    const command = parseInboundCommand(envelope(vi.fn()), "forget", { topic: "the deadline" });

    // Exhaustive by construction: a fourth command would fail to compile here.
    switch (command.name) {
      case "forget":
        expect(command.args.topic).toBe("the deadline");
        break;
      case "purge":
      case "redact":
        expect.unreachable("parsed as the wrong command");
    }
  });

  it("refuses a name it does not declare", () => {
    expect(() => parseInboundCommand(envelope(vi.fn()), "delete", { topic: "x" })).toThrow(
      /Unknown command: delete/,
    );
  });

  it("refuses an empty topic, naming the command", () => {
    expect(() => parseInboundCommand(envelope(vi.fn()), "purge", { topic: "   " })).toThrow(
      /\/purge/,
    );
  });

  it("hands the result back through the one lifecycle call it has", async () => {
    const respond = vi.fn<(result: CommandResult) => Promise<void>>().mockResolvedValue(undefined);
    const command = parseInboundCommand(envelope(respond), "forget", { topic: "the deadline" });

    await command.respond({ kind: "forgotten", topic: command.args.topic, factsInvalidated: 2 });

    expect(respond).toHaveBeenCalledWith({
      kind: "forgotten",
      topic: "the deadline",
      factsInvalidated: 2,
    });
  });
});
