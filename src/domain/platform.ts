/**
 * The platforms cadence has an adapter for.
 *
 * A closed union rather than a bare string, because [ADR 0002](../../docs/adr/0002-memory-scope.md)
 * makes this a segment of every scope key, and the segment exists so a Slack id can never collide
 * with a Discord snowflake. A typo'd platform under `string` would produce a valid-looking key for a
 * scope nothing else can reach.
 *
 * Adding a platform is a one-word change here. That is the price of the guarantee, and it is the
 * only place outside `src/channel/<platform>/` that a new adapter touches.
 */
export const PLATFORMS = ["discord"] as const;

export type Platform = (typeof PLATFORMS)[number];
