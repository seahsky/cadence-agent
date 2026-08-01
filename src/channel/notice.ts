import type { EntryId, Platform, Scope } from "../domain/index.js";

/**
 * One structured report on the operator surface.
 *
 * **Every variant carries values, never rendered text.**
 * [ADR 0005](../../docs/adr/0005-storage.md) requires a purge confirmation to state the date the
 * destroyed content ages out of backups, and Discord renders `<t:…:D>` and `<t:…:R>` natively. That
 * only works if the notice carries a `Date` and the adapter formats it. A pre-rendered string
 * throws the affordance away, makes notices untestable, and forecloses a second sink.
 *
 * The operator surface is a destination that holds no entry tree, is never subscribed for inbound,
 * and is never assembled into context. It reaches the adapter through the {@link Notify} port, so
 * storage depends on a function rather than on Discord.
 */
export type Notice =
  | PassRefused
  | SpendCapCrossed
  | ConfigWarning
  | GitUnhealthy
  | CrashRecovery
  | Quarantined
  | StalenessTransition
  | PurgeConfirmed
  | SendFailed
  | InboundOverflow
  | InvalidRequests;

/** The background passes, in the order [ADR 0006](../../docs/adr/0006-model-routing.md) sheds them. */
export type BackgroundPass = "playbooks" | "nightly-sweep" | "brief" | "reconcile";

/**
 * A pass cadence declined to run because the five-hour window was too far gone.
 *
 * Reported rather than swallowed, because the honest consequence of the graded ladder is that when
 * the owner's own coding holds the window, cadence keeps talking and stops remembering. A refused
 * pass is dropped with no queue, so this notice is the only record it was ever due.
 */
type PassRefused = {
  readonly kind: "pass-refused";
  readonly pass: BackgroundPass;
  /** Five-hour window consumption in utilization points, 0 to 100. */
  readonly utilization: number;
  /** The ladder rung that refused it: 60 playbooks, 70 sweep, 80 brief, 90 reconcile. */
  readonly threshold: number;
};

/**
 * The configured daily spend was passed. Cadence keeps working, because the ceiling is soft by
 * default: the one unbounded spender is a runaway tool loop, and the agent loop's iteration cap is
 * the right instrument for that. Never includes `claude -p`'s `total_cost_usd`, which is accounting
 * rather than a charge.
 */
type SpendCapCrossed = {
  readonly kind: "spend-cap-crossed";
  readonly spentUsd: number;
  readonly capUsd: number;
  /** The day being accounted, so a crossing is attributable after the fact. */
  readonly day: Date;
};

/**
 * A routing configuration that works but contradicts a recorded decision — memory formation on
 * OpenRouter, digest failover disabled, a reply model with no tool support. The owner's money and
 * the owner's call, so cadence says what it has done rather than silently obeying. A configuration
 * that cannot run is rejected at boot instead and never reaches here.
 */
type ConfigWarning = {
  readonly kind: "config-warning";
  /** Path to the offending setting in the routing document. */
  readonly setting: string;
  readonly configured: string;
  /** The decision it contradicts, as a document reference such as `ADR 0006`. */
  readonly contradicts: string;
};

/**
 * Three consecutive commit failures, so git is declared unhealthy and the reconcile, brief and
 * staleness passes stop proposing writes. Reads are untouched and cadence keeps answering with
 * everything it already knows.
 *
 * This matters because there is no approval gate on background fact writes and git history is the
 * accountability instead. If git cannot record them, unattended writes have lost what made them
 * acceptable. One notice per streak, not per attempt.
 */
type GitUnhealthy = {
  readonly kind: "git-unhealthy";
  readonly consecutiveFailures: number;
  readonly lastError: string;
};

/**
 * A crash landed between writing fact files and committing them, and the roll-forward committed
 * what was there. Reported rather than done silently: the files that landed are each independently
 * valid, but the owner should know a batch was interrupted, and the alternative is discarding
 * reconciler work with no record.
 */
type CrashRecovery = {
  readonly kind: "crash-recovery";
  /** When the interrupted batch was recorded in the write-ahead row. */
  readonly recordedAt: Date;
  readonly committedPaths: readonly string[];
};

/**
 * A fact file failed front-matter validation and was moved aside. Not fatal, because one malformed
 * file must not take down a session, and a real location because otherwise every later scan trips
 * on the same file.
 */
type Quarantined = {
  readonly kind: "quarantined";
  readonly path: string;
  readonly reason: string;
};

/**
 * A fact went unconfirmed long enough to fall out of the index. The staleness sweep writes nothing
 * — ageing out is a property of the fact rather than a change made to it — so this notice is the
 * whole output of the observation.
 */
type StalenessTransition = {
  readonly kind: "staleness-transition";
  readonly scope: Scope;
  /** The fact's front-matter key. */
  readonly key: string;
  readonly lastConfirmedAt: Date;
};

/**
 * A purge finished. What is kept is that a deletion happened, not the deleted thing, so this
 * carries counts and never content.
 *
 * `backupsAgeOutAt` is load-bearing rather than informational. Purge destroys the live copy
 * immediately and backups age out on their retention clock, so the guarantee is "destroyed from
 * everything cadence reads, now, and from disk entirely by this date". Naming the date is what
 * stops the word "purge" doing work it cannot.
 */
type PurgeConfirmed = {
  readonly kind: "purge-confirmed";
  readonly topic: string;
  readonly requestedBy: string;
  readonly factsDestroyed: number;
  readonly entriesTombstoned: number;
  readonly backupsAgeOutAt: Date;
};

/**
 * A send that will not succeed on a retry. Rate limits and 5xx never reach here: `@discordjs/rest`
 * already retries those, and a failure in the reply path is structurally unreportable through the
 * reply path, which is why this goes to the operator instead of to the agent.
 */
type SendFailed = {
  readonly kind: "send-failed";
  readonly reason: "permission" | "permanent";
  readonly detail: string;
  /** The entry whose reply was lost, or `null` if the send was not part of one. */
  readonly entryId: EntryId | null;
};

/**
 * The inbound buffer overflowed. The gateway pushes whether cadence is ready or not, so the source
 * is bounded with a stated overflow policy rather than an unbounded queue that turns a slow turn
 * into a memory leak — which means dropping, which means saying so.
 */
type InboundOverflow = {
  readonly kind: "inbound-overflow";
  readonly platform: Platform;
  readonly dropped: number;
  readonly capacity: number;
};

/**
 * The platform is counting cadence's malformed requests toward a ban. Surfaced because the
 * consequence of missing it is a temporary IP restriction, and on Discord the warning interval
 * defaults to off and must be set explicitly.
 */
type InvalidRequests = {
  readonly kind: "invalid-requests";
  readonly platform: Platform;
  readonly count: number;
  readonly limit: number;
  readonly windowMinutes: number;
};
