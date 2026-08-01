import { describe, expect, it } from "vitest";
import { type EntryId, EntryIdSchema, type NativeId, NativeIdSchema } from "./ids.js";

describe("branded ids", () => {
  it("admits a non-empty string and rejects an empty one", () => {
    expect(EntryIdSchema.parse("e1")).toBe("e1");
    expect(NativeIdSchema.parse("n1")).toBe("n1");
    expect(() => EntryIdSchema.parse("")).toThrow();
    expect(() => NativeIdSchema.parse("")).toThrow();
  });

  it("does not let one stand in for the other", () => {
    const entry: EntryId = EntryIdSchema.parse("e1");
    const native: NativeId = NativeIdSchema.parse("n1");

    // @ts-expect-error a native id is not an entry id, which is the whole point of the brand
    const swapped: EntryId = native;

    expect(swapped).not.toBe(entry);
  });
});
