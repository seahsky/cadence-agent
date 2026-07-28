# Routing is one predicate over named jobs, and memory formation never spends

ADR 0003 settled what the two providers look like from the outside.
This settles which one each piece of work goes to, and what happens when the cheap one is unavailable.

The subscription creates a cost asymmetry worth designing around.
Background model work that would be too expensive to run on every turn at per-token prices is close to free on a subscription, which is why this decision feeds the memory architecture rather than merely following it.

## The routing key is one predicate, not a taxonomy

```
needsTools || blocksAHuman  →  OpenRouter
otherwise                   →  claude -p
```

Both operands are properties of a **job**, a named kind of model work fixed at authoring time.
Neither is computed at runtime, and no model ever chooses its own provider.
Runtime choice was rejected as flexibility that is indistinguishable from unpredictable spend.

| Job | Needs tools | Blocks a human | Provider |
| --- | --- | --- | --- |
| Reply and tool loop | yes | yes | OpenRouter |
| Materiality check on an edit | no | yes | OpenRouter |
| Digest | no | no | `claude -p`, see failover |
| Reconcile pass | no | no | `claude -p` |
| Nightly sweep | no | no | `claude -p` |
| Brief pass | no | no | `claude -p` |
| Playbook proposals | no | no | `claude -p` |
| Staleness sweep, deterministic prune | no model at all | n/a | none |

The ticket's proposed taxonomy of six job types does not survive contact with the table.
Nothing distinguishes reconcile from brief *for provider choice*; they differ for degradation order and model pinning, which are separate columns.
The taxonomy is real and load-bearing, and it is not the routing key.

**Embedding is not a job.**
The read path is whole-index injection under a cap, so the architecture never asked for a vector store, and grep over markdown has not been shown to lose.

### `blocksAHuman` is a dimension the architecture works to keep empty

It has exactly one member, the materiality check from ADR 0001, and collapsing it to an exception would be a mistake.
It is a dimension because it names the invariant, and the invariant is what a future ticket needs: **no LLM job may be scheduled on the blocking path.**
Without the name, scheduling a digest pre-turn reads as a slow path rather than a violation.

## Compaction is post-turn, which is what keeps the digest off the blocking path

ADR 0004 routes the digest to `claude -p` and also places it inside compaction, which fires when the working set crosses 70% of a reserve-adjusted budget.
If that threshold were evaluated while assembling a live turn, the digest would sit on the blocking path behind a global semaphore of 1, roughly 500ms of process startup and an observed maximum of 70.5 seconds.
A Discord reply would queue behind whatever background pass got there first.

**So the boundary forms after the reply goes out, never before it.**
Crossing 70% on turn N sends the reply, then forms the boundary before turn N+1 assembles.
The remaining 30% is not slack that happens to exist; it is the budget that pays for the deferral.

A turn that overshoots anyway runs the deterministic prune alone, which uses no model, and proceeds without a digest.

The rejected alternative was to send the digest to OpenRouter whenever it turned out to be blocking.
That makes the same job run on two different models depending on how full the context happened to get, so digest quality would vary with how busy the session was, and memory would get worse exactly when the session had the most in it.

## Memory formation never spends; the digest may

The digest is not a memory pass.
Its consumer is the working set, not the fact store.
ADR 0004 groups it with reconcile and brief because all three fire at a boundary, but reconcile and brief write things that outlive the session, while the digest writes something the next turn reads.
It is live-path infrastructure wearing a background pass's clothes, and that is the line failover follows.

- **Reconcile, brief, nightly sweep and playbook proposals are subscription or nothing.**
  A pass that does not run loses nothing permanently, because the episodic log is append-only and the nightly sweep is the watermark.
  A cheap model writing facts corrupts a store that outlives the session.
- **The digest fails over to OpenRouter when the subscription window is shut.**
  This is the only failover in the design.
  It exists because the digest is the one pass whose absence degrades the live conversation rather than deferring memory.

The failover trigger is headroom exhaustion, not context fullness.
That distinction is the whole reason it is acceptable here and was rejected above: a window that is shut is an emergency, and the alternative is entries leaving context with no summary at all.

**The price, stated rather than discovered later.**
Digests are never recomputed, so a window-exhausted afternoon leaves a session with permanently mixed-provenance context.
The alternative considered was deterministic tail truncation with a visible marker, which fails honestly and lossily rather than completely and unevenly.
It was rejected because "cadence got worse at this because you were coding" is a bad property for a personal agent, and the entries are still in the log either way.

## The five-hour window is shared with the operator, so cadence yields before the wall

#15 measured cadence's background load at one to two points of a five-hour window per day and called it affordable by a wide margin.
That margin is only real if cadence is the sole consumer of the window, and it is not: the subscription is the operator's, and they use it for their own work.

So cadence reserves headroom rather than running to the wall.
Passes drop in ADR 0004's order as `five_hour.utilization` climbs, read from `api/oauth/usage` on the cached poll interval ADR 0003 established.

| Utilization | What stops |
| --- | --- |
| 60% | Playbook proposals |
| 70% | Nightly sweep |
| 80% | Brief pass |
| 90% | Reconcile at boundary; the digest fails over to OpenRouter |

Grading rather than a single cliff is what makes the reservation useful.
One threshold means cadence is either fully consuming the window or fully idle, which throws away ADR 0004's whole point that these passes are worth different amounts.
Above 90% cadence performs no subscription model work at all, leaving the last tenth of every window to the operator.

**The order survives the measurement, which was not guaranteed.**
`#20` found the cost intuition in ADR 0004 inverted: the brief pass is the most expensive of the three at $0.0227 notional against reconcile's $0.0161, because it is replaced wholesale so its cost is carried by output.
Shedding brief at 80% therefore saves the most window *and* sheds the third-least-valuable pass.
Value order and cost order agree, so no reordering is needed.

The headroom read is optional by construction, per ADR 0003.
If the fetch fails or the undocumented shape drifts, every threshold is unreachable and cadence degrades to the denial event as its only guard.

## A refused pass is dropped, and the sweep is the backstop

There is no deferral queue anywhere.
The nightly sweep is a reconcile pass over touched scopes, which is what a drained queue would produce, except idempotent, batched, and already in the design.
The brief pass is already capped at one pending job per scope, and depth one is correct because a brief is replaced wholesale, so a stale pending brief has no value over a fresh one.

This is what makes deferral free: no durable job table, no retry policy, and nothing that grows without bound while the operator's own work holds the window.

**The honest consequence: when the operator's coding consumes the window, cadence keeps talking and stops remembering.**
The reply loop is on OpenRouter and is unaffected.
Memory formation halts until the window reopens, and per ADR 0004 each refusal is reported to the operator channel rather than swallowed.

## Model pinning

ADR 0003 requires an explicit model on every `claude -p` invocation, because an unpinned one resolves from the operator's settings and inherits `opus[1m]`.
These are defaults, not decisions; all are configurable.

| Job | Provider | Default model |
| --- | --- | --- |
| Reply and tool loop | OpenRouter | none, see below |
| Materiality check | OpenRouter | cheapest capable |
| Digest | `claude -p` | Sonnet |
| Reconcile pass | `claude -p` | Sonnet |
| Nightly sweep | `claude -p` | Sonnet |
| Brief pass | `claude -p` | Haiku |

**Reconcile gets Sonnet** because it chooses between `ADD`, `UPDATE` and `INVALIDATE` against beliefs that already exist, which is a judgement about contradiction and supersession.
A weak model fails at it in one direction: it adds, because `ADD` is always locally defensible.
That rebuilds the only-ever-grows store ADR 0004 was written to fix, so the spend here protects that ADR's central claim rather than buying general quality.

**Brief gets Haiku** because it is replaced wholesale every pass, so a bad brief is corrected sixty seconds later, and because it is both the most frequent pass and the one whose cost is dominated by output tokens.
The cheap model on the output-heavy pass is the right shape.

**This pinning is contingent on `#20`.**
If the brief moves from wholesale rewrite to proposing operations, its output collapses and its cost profile inverts again, and the Haiku default should be revisited rather than inherited.

**The reply model is deliberately not decided here.**
Which model the operator talks to is a taste and cost question that changes independently of routing, and baking it into the routing table would be a category error.
It is configuration with no default, so a missing value fails at boot rather than silently resolving to something.

## The policy is validated data, not code

Everything is configurable.
Defaults ship in code so cadence boots with no config file, and the document is validated at load with an explicit failure, matching the existing pattern in `src/config/env.ts`.

Enforcement moves to validation rather than to absence.
Making the provider column unconfigurable would have prevented bad configurations by making them inexpressible; validating them instead means they can be written, and are rejected with a readable message naming the job and the reason.

- **Rejected at load.** A tool-capable job routed to `claude -p`. ADR 0003 makes the subprocess provider throw on a non-empty tools array, so this configuration cannot run, and boot fails rather than crashing on the first reply.
- **Warned at load, and reported to the operator channel.** Anything that works but contradicts a recorded decision: memory formation routed to OpenRouter, digest failover disabled, a reply model with no tool support. The operator's money and the operator's call, and cadence says what has been done rather than silently obeying.

Nothing is validated at runtime.
A configuration that boots is a configuration that routes.

## The dollar ceiling is soft by default

Crossing the configured daily figure posts to the operator channel and cadence keeps working.
A hard stop is available as configuration; it is not the default.

After the failover decision above, OpenRouter carries the reply loop, the materiality check and the rare emergency digest.
The materiality check is one cheap call per edit.
The reply loop is gated by how fast a human types, with one exception: a tool loop that does not terminate.

That is the only unbounded spender in the design, and a dollar cap is the wrong instrument for it.
The right one is a maximum-iteration cap in the agent loop.
A hard stop buys protection against a runaway that a loop cap already prevents, and costs an agent that goes silent mid-conversation because a background pass crossed a line the operator had forgotten about.
For a single-operator personal agent, silent is worse than a few dollars.

`total_cost_usd` from `claude -p` is never summed into this figure.
Per ADR 0003 it is accounting rather than a charge, and it lives in `notionalCost` with `cost.total` at zero.

## Two amendments to ADR 0004

- **Compaction is post-turn.** ADR 0004 places the digest inside compaction at a 70% threshold without saying when it is evaluated. It is evaluated after the reply is sent, and the digest is never on the blocking path.
- **The nightly sweep reads a watermark, not a day.** ADR 0004 scopes it to "scopes touched that day", which assumes the sweep always runs. Under a contended window it may itself be refused, so its input is **scopes touched since the last successful sweep**. This is what makes drop-with-no-queue safe.

## Consequences

- **`#12` gains nothing and `#20` gains a dependency.** The reconciler's input bound is still open, and if it is unbounded then reconcile cost grows with the fact store forever, which will eventually reorder the threshold table above.
- **The agent loop ticket inherits the runaway guard.** A maximum-iteration cap is now load-bearing for cost control, because the dollar ceiling deliberately does not stop anything.
- **The operator channel gains three reports**: pass refusals with the utilization that caused them, the soft dollar cap crossing, and config warnings at boot.
- **Deployment inherits a credential and a document.** The headroom read needs its own long-lived token from `claude setup-token`, and the routing configuration document has to be placed wherever cadence runs.
- **A configuration UI is unblocked and out of scope.** Any editing surface, whether a hand-edited file, an operator command or a web app, is a writer of the same validated document. Deciding the document is what makes the surface cheap; building one is a separate effort.
- **`CONTEXT.md` gains one term**, **Job**, which is what routing keys on.
