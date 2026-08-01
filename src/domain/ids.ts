import { z } from "zod";

/**
 * The two identifiers the seams pass each other, branded so they cannot be swapped.
 *
 * `EntryIds` in the channel layer converts between them in both directions, and both sides of every
 * conversion are strings. Under a plain `string` alias a transposed argument type-checks and the
 * failure shows up as a reply posted against the wrong message.
 *
 * Branding through zod rather than a bare `unique symbol` keeps one definition doing both jobs: the
 * type that stops the swap, and the parser that admits the value at the boundary.
 */

/**
 * Cadence's own identifier for an entry.
 *
 * Assigned by cadence, never by a platform. It survives a purge — a tombstone keeps `id` and
 * `parentId` so tree walks and digests do not break
 * ([ADR 0005](../../docs/adr/0005-storage.md)).
 */
export const EntryIdSchema = z.string().min(1).brand<"EntryId">();

export type EntryId = z.infer<typeof EntryIdSchema>;

/**
 * A platform's own identifier for something cadence has projected into the domain.
 *
 * Opaque above the adapter, which owns the encoding: a Discord message needs its channel as well as
 * its snowflake to be editable, and only the adapter may know that. Nothing outside
 * `src/channel/<platform>/` parses one.
 *
 * One entry maps to many native ids, because a reply is chunked to fit the platform.
 */
export const NativeIdSchema = z.string().min(1).brand<"NativeId">();

export type NativeId = z.infer<typeof NativeIdSchema>;
