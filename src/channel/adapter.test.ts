import { describe, expect, it } from "vitest";
import { type EntryId, EntryIdSchema, type NativeId, NativeIdSchema } from "../domain/index.js";
import { type ChannelAdapter, type ReplyTarget, UnsupportedOperation } from "./adapter.js";
import type { Inbound } from "./inbound.js";
import type { Notice } from "./notice.js";
import type { EditJudge, EntryIds, Notify } from "./ports.js";

/**
 * A surface with no branching primitive, driven by three fakes and nothing else.
 *
 * This is the interface's own claim under test: the adapter's entire outside world is three
 * functions, so an implementation needs no database, no model and no gateway. If that stops being
 * true, this file is where it stops compiling.
 */

const fakeEntryIds = (): EntryIds & { readonly bound: Map<EntryId, readonly NativeId[]> } => {
  const bound = new Map<EntryId, readonly NativeId[]>();

  return {
    bound,
    toEntry: async (native) =>
      [...bound].find(([, natives]) => natives.includes(native))?.[0] ?? null,
    toNative: async (entry) => bound.get(entry) ?? [],
    bind: async (entry, natives) => {
      bound.set(entry, natives);
    },
  };
};

const neverEdits: EditJudge = async () => "cosmetic";

const collectNotices = (): Notify & { readonly seen: Notice[] } => {
  const seen: Notice[] = [];
  const notify: Notify = async (notice) => {
    seen.push(notice);
  };

  return Object.assign(notify, { seen });
};

/** Splits at four characters, which is this surface's version of Discord's 2000. */
const createTinyChannel = (deps: {
  readonly entryIds: EntryIds;
  readonly editJudge: EditJudge;
  readonly notify: Notify & { readonly seen: Notice[] };
}): ChannelAdapter & { readonly sent: string[] } => {
  const sent: string[] = [];
  let nextNative = 0;

  return {
    sent,
    platform: "discord",
    start: async () => {},
    stop: async () => {},
    inbound: (): AsyncIterable<Inbound> => ({
      [Symbol.asyncIterator]: async function* () {},
    }),
    reply: async (at: ReplyTarget, deltas: AsyncIterable<string>) => {
      const natives: NativeId[] = [];
      let buffer = "";

      const flush = (): void => {
        if (buffer === "") return;
        sent.push(buffer);
        nextNative += 1;
        natives.push(NativeIdSchema.parse(`n${nextNative}`));
        buffer = "";
      };

      try {
        for await (const delta of deltas) {
          buffer += delta;
          while (buffer.length >= 4) {
            const chunk = buffer.slice(0, 4);
            buffer = buffer.slice(4);
            sent.push(chunk);
            nextNative += 1;
            natives.push(NativeIdSchema.parse(`n${nextNative}`));
          }
        }
        flush();
      } finally {
        // The reason outbound is consumed rather than pushed: whatever the model did, the surface
        // records what it managed to send.
        await deps.entryIds.bind(at.entryId, natives);
      }

      return natives;
    },
    branch: async () => {
      throw new UnsupportedOperation("discord", "start a branch in this test surface");
    },
    fetchAttachment: async () => {
      throw new UnsupportedOperation("discord", "fetch attachments in this test surface");
    },
    notify: deps.notify,
  };
};

const deltas = async function* (...parts: readonly string[]): AsyncIterable<string> {
  for (const part of parts) {
    yield part;
  }
};

describe("ChannelAdapter", () => {
  const target: ReplyTarget = {
    entryId: EntryIdSchema.parse("e-reply"),
    inReplyTo: EntryIdSchema.parse("e-asked"),
  };

  it("drives a whole reply from three fakes", async () => {
    const entryIds = fakeEntryIds();
    const notify = collectNotices();
    const channel = createTinyChannel({ entryIds, editJudge: neverEdits, notify });

    const natives = await channel.reply(target, deltas("abcde", "fgh"));

    expect(channel.sent).toEqual(["abcd", "efgh"]);
    expect(natives).toHaveLength(2);
    expect(entryIds.bound.get(target.entryId)).toEqual(natives);
  });

  it("binds one entry to many native ids, because chunking splits a reply", async () => {
    const entryIds = fakeEntryIds();
    const channel = createTinyChannel({
      entryIds,
      editJudge: neverEdits,
      notify: collectNotices(),
    });

    const natives = await channel.reply(target, deltas("abcdefghij"));

    expect(natives.length).toBeGreaterThan(1);
    expect(await entryIds.toEntry(natives[0] as NativeId)).toBe(target.entryId);
    expect(await entryIds.toNative(target.entryId)).toEqual(natives);
  });

  it("records what it sent when the stream dies mid-reply", async () => {
    const entryIds = fakeEntryIds();
    const channel = createTinyChannel({
      entryIds,
      editJudge: neverEdits,
      notify: collectNotices(),
    });

    const failing = async function* (): AsyncIterable<string> {
      yield "abcd";
      throw new Error("the model gave up");
    };

    await expect(channel.reply(target, failing())).rejects.toThrow("the model gave up");
    expect(entryIds.bound.get(target.entryId)).toHaveLength(1);
  });

  it("throws rather than silently no-opping an operation it cannot perform", async () => {
    const channel = createTinyChannel({
      entryIds: fakeEntryIds(),
      editJudge: neverEdits,
      notify: collectNotices(),
    });

    await expect(channel.branch(target.inReplyTo, "a title")).rejects.toBeInstanceOf(
      UnsupportedOperation,
    );
  });

  it("carries a purge confirmation as values, with the ageing-out date unrendered", async () => {
    const notify = collectNotices();
    const channel = createTinyChannel({
      entryIds: fakeEntryIds(),
      editJudge: neverEdits,
      notify,
    });

    const backupsAgeOutAt = new Date("2026-10-30T00:00:00Z");

    await channel.notify({
      kind: "purge-confirmed",
      topic: "the api key",
      requestedBy: "u1",
      factsDestroyed: 1,
      entriesTombstoned: 3,
      backupsAgeOutAt,
    });

    const [notice] = notify.seen;

    expect(notice?.kind).toBe("purge-confirmed");
    expect(notice).toMatchObject({ backupsAgeOutAt });
  });
});
