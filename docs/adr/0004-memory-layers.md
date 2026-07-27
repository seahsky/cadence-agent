# Six memory layers, cut by append-only versus reconciled, with a reconciler that proposes and never writes

The starting position was short-term memory, long-term memory, and a way to link them.
That instinct has the right shape and the wrong cut.

**The load-bearing boundary is append-only versus reconciled.**
An append-only store never contradicts itself, so it needs indexing and retention but never judgement.
A reconciled store contradicts itself constantly, so it needs an operation set, provenance, and something willing to decide what is no longer true.
Those are different engineering problems, and short-versus-long puts the episodic log and the fact store on the same side of a boundary they do not belong on.

Sorting by that gives six layers.

| | Layer | Kind | Holds |
| --- | --- | --- | --- |
| L0 | Turn buffer | append-only, disposable | Debounced inbound messages merged into one turn, attachment bytes, typing state |
| L1 | Working set | no storage | A pure function of the tree, the leaf, and the readable scopes |
| L2 | Episodic log | append-only, permanent | The entry tree and its digest nodes, never mutated, full-text searchable |
| L3 | Brief | reconciled | Active task, open loops, commitments with dates |
| L4 | Facts | reconciled | What cadence believes, invalidated rather than deleted |
| L5 | Playbooks | reconciled | Named procedures, listed always, bodies read on demand |

L0 and L1 are disposable, L2 is permanent, and L3 to L5 are the only place anything is ever retracted.

L0 to L2 are already specified elsewhere: ADR 0001 fixes the tree, sessions as spans, boundaries and digests, and ADR 0002 fixes what scope a read or write carries.
This ADR is about L3 to L5, the passes that write them, and the moment those passes fire.

## The brief holds state, not summary

One brief per scope, using the read set from ADR 0002 unchanged.
A user brief and a channel brief render for the same reason their facts do, and no new scoping concept is introduced.
Capped at 1,500 characters, enforced by code when the write lands rather than requested in a prompt.

**The brief does not carry the inherited digest.**
Folding it in would give a session one artifact to open with instead of two, and it would put an append-only artifact inside a reconciled file.
A digest is computed from the entries its boundary replaces and is never rewritten; a brief is replaced wholesale on every pass.
Merged, the reconciler could silently rewrite a digest, leaving the tree's own record and the prose disagreeing with nothing to arbitrate.

The brief is deliberately thin.
It exists so that a compaction does not cost the agent its grip on what it was doing, which is the failure behind the public case where reported progress fell from 97% to 42% through a single compaction.
Anything richer competes for the same attention window as the fact index, and that window, not price, is the binding constraint.

## The file is the fact

`facts/<scope>/<key>.md`, where the key is the topic slug.
Front-matter carries `key`, `asof`, `src`, `confirmations`, `invalidatedAt` and `invalidatedBy`.
The body is the statement and any nuance.

One file per topic was the alternative and it does not survive contact with its own front-matter: those fields are per-fact, front-matter is per-file, and a topic file holds many facts.
Under it, `UPDATE` becomes a surgical edit inside a file by a model that cannot be trusted with surgical edits, and provenance can only be recorded for the topic as a whole, so you would know the file changed and not which belief did.
With the file as the fact, `ADD` writes a file, `UPDATE` rewrites one, `INVALIDATE` stamps two fields, the index renders from front-matter without parsing bodies, and git history per file is that fact's audit trail.

Three rules on the fields:

- **`asof` is the last-confirmed date and `confirmations` is a plain count.** No score, no ranking, anywhere. Pi's extension scores only ever increase against linear decay at 0.05/day, so a wrong belief reinforced five times needs 130 days to fall below a correct new one, and twenty hits needs roughly 500. A count is useful to a human reading the file and worthless to sort by, which is what it is for.
- **`src` is written by code, never supplied by the model.** It names the episodic entry the fact came from. Models routinely omit the arguments they are asked to provide on edits, and this is the field that makes a wrong fact auditable and a deletion precise.
- **`key` is unique among live facts in a scope.** Code rejects an `ADD` whose key already exists, forcing it to be an `UPDATE`.

Playbooks use the same shape and the same operations.
**Bodies are prose only.**
A body is markdown the model reads and follows, so fetching it is running it, which keeps sandboxing out of this design entirely.
Once a body can carry a script, a tool allowlist or MCP config, loading one changes what the agent is permitted to do, and the reconciler's safety property inverts: a bad proposal stops being rejectable text and becomes an execution primitive.
Executable playbooks are a later effort with their own ADR.

## The read path is injection, under a hard cap

Always on, at the tail of the cached prefix, in fixed assembly order: the briefs for the read scopes, the fact index as `key: statement` for every live fact, playbook names with one-line descriptions, and the branch pointers from ADR 0001.

Progressive disclosure is the right read path for playbooks and the wrong one for facts.
If a fact's body is one line, an index entry carrying its statement is the fact, and disclosure buys nothing but a round trip inside a reply the user is waiting on.
Injection also wins on price below roughly 2,000 tokens, because the block sits at the tail of a byte-identical prefix and is read from cache, while retrieved facts land after the cache boundary at full price every turn.

**A hard cap of 2,000 tokens on the whole memory block, enforced by code.**
Above it, attention degrades and retrieval starts winning; a cap is also the only growth bound that needs no judgement, which is why Hermes's character cap is the best single decision in either reference system.

**Eviction is deterministic: oldest `asof` first.**
What leaves the rendered block goes to an archive that stays searchable and is never injected.

> **Amended by [ADR 0005](0005-storage.md).**
> The archive is not a location.
> Because eviction is recomputed whenever memory changes, a fact crowded out today has to be able to come back, so nothing is moved: the archive is the set of live facts the render did not select.

Two rules that fix named defects:

- **Re-render when memory changes, not once at session start.** Hermes freezes long-term memory as a load-time snapshot, so a fact corrected mid-session is invisible for the rest of it: the agent agrees with you, saves it, and violates it four turns later. Changes are rare, so a cache write on change is cheap.
- **Nothing rendered carries a timestamp.** pi-self-learning stamps `Last updated: <ISO>` into its file on every reflection, so no two copies are byte-identical and the prompt cache never hits, for zero model value. `asof` is read by the sweep, not rendered into the prompt.

On demand: playbook bodies by name, and search over the episodic log.
Both are tools closed over the already-resolved scope set and take no scope argument, per ADR 0002.

## Four producers of operations, and code is the only writer

Every write is an operation from the set `ADD`, `UPDATE`, `INVALIDATE`, `NOOP`, validated and applied by cadence's own code.
`NOOP` matters as much as the rest: a pass that finds nothing worth changing has to be able to say so without inventing work.

| Producer | Fires | Runs on |
| --- | --- | --- |
| Reconcile pass | Every boundary, plus a nightly sweep over scopes touched that day | `claude -p` |
| Brief pass | Turn end, debounced 60s, at most one pending job per scope | `claude -p` |
| Staleness sweep | Daily | No LLM at all |
| Explicit request | When the owner asks cadence to remember something | The live turn |

**Firing reconciliation on boundaries rather than at session end** collapses two triggers into one, since ADR 0001 already makes a session roll and a mid-session compaction the same act.
It also picks up the sharper timing for free: the highest-value moment to ask what should survive is the instant information is about to be irreversibly degraded.
Hermes has exactly that hook and only its external providers use it, firing its own reviewer on a 10-turn clock that triggers on sessions where nothing happened and misses long tool-heavy sessions that compact twice inside ten turns.

**The brief pass cannot wait for a boundary**, because surviving the boundary is its whole purpose.
Its input is small: the current brief and the turns since it was last written.

> **Amended by [ADR 0006](0006-model-routing.md).**
> The nightly sweep's input is **scopes touched since the last successful sweep**, not scopes touched that day.
> "That day" assumes the sweep always runs, and under a contended five-hour window it may itself be refused.
> The watermark is what makes ADR 0006's drop-with-no-queue safe: a refused pass is dropped rather than queued, because the sweep is guaranteed to pick it up.

**The staleness sweep uses no model.**
Every other path to changing memory routes through a model decision, which is the measurably fragile step, so the one producer that cannot forget or hallucinate is worth having.

> **Amended by [ADR 0005](0005-storage.md).**
> The sweep produces no operations.
> The 90-day rule is a predicate over `asof`, evaluated by the render, so the sweep observes transitions and reports them to the operator channel rather than writing.
> It remains the one pass that cannot forget; it is not a writer.

**An explicit request writes immediately** and re-renders, so it is in context on the next turn.
It may emit all four operations, because the owner is present to see the result, which is the safest moment a write ever happens.
Deferring an explicit "remember that" to a nightly pass is the mid-session invisibility defect in a different costume.

What makes the background producers safe is that they run with `--tools ""` and a JSON-only contract per ADR 0003.
The model has no filesystem access, so its worst failure is a proposal validation rejects rather than a corrupted store, and the caps are enforced by code rather than requested in a prompt.

There is no approval gate on background fact writes.
A queue you must approve is a queue that rots, and it does not survive a nightly pass that runs while the owner is asleep.
Git history is the accountability instead.

## Invalidation is bounded, not propagated

`UPDATE` when the key still has a true value, `INVALIDATE` when it no longer has one.
`INVALIDATE` stamps `invalidatedAt` and `invalidatedBy` and leaves the file in place, so the index drops the fact while git keeps the trail.
Per ADR 0002, reconciliation operates strictly within one scope, and no level ever supersedes another.

**Derived facts do not cascade, and there is no `derivedFrom` edge.**
You move from Lisbon to Berlin, `home-city` updates cleanly, and the fact that says you commute via the M4 was derived from the old one, is now false, and nothing links them.
Nobody in the field handles this, Zep and mem0 included.

The reconciler receives the whole index anyway, because it has to in order to reuse keys rather than inventing `lives-in` alongside `home-city`, so it can propose several operations in one batch when a change has knock-on effects.
It will catch some and miss some.
A `derivedFrom` edge would mean the model supplying a link on every write, and a half-populated dependency graph is worse than none because it looks like coverage.

What makes that acceptable is the bound.
**A fact whose `asof` is older than 90 days without re-confirmation leaves the index.**
A personal fact confirmed within the last quarter is probably still true, and one nobody has touched in three months has earned a re-confirmation.
Hermes's only cleanup is the character budget filling up, and Pi's extension has none at all, with a documented route back into context for a belief that fell out of its top 20.
A stale fact that expires on a deterministic clock is strictly better than both and needs no new structure.

## Forget retracts a belief, purge destroys a record

Two commands, because they mean two different things, and cadence says which one it did.

**`forget <topic>`** is `INVALIDATE` with a reason.
The file stays, the index drops it, git keeps the trail, and it never steers a reply again.
It does not touch the episodic log, for the reason ADR 0001 already gives for dead paths: the record stays honest.

Cadence says so in the reply rather than leaving it in a doc.
After `forget`, the conversation where you said the thing is still in the log and still searchable.
Tombstoning means "deleted" is a lie at the storage layer, and the fix is not a stronger tombstone, it is not telling the lie.

**`purge <topic>`** destroys it.
It deletes the fact file, blanks the episodic entries the fact came from into content-free tombstones that keep `id` and `parentId` so tree walks and digests do not break, rewrites the fact store's git history for the affected paths, and writes one audit row: key, timestamp, who asked, never content.
What is kept is that a deletion happened, not the deleted thing.

Rewriting git history is normally a bad idea and here it is not.
This is a local store with no remote and nothing sharing its history.
Without it, every secret the owner ever asked cadence to destroy sits in a directory the agent itself called the audit trail.

`src` is what makes purge possible.
Without provenance it is a full-text guess over the log, which either misses copies or destroys unrelated conversation.

Neither command cascades on its own, and only the owner may invoke either.
The reconciler proposes `INVALIDATE`; it never proposes `forget` or `purge`.

## Redaction guards promotion, not conversation

One scrub function, called at two boundaries: anything leaving for a subprocess, and anything about to be written to a reconciled file.
Digests, brief passes and reconcile passes all run on `claude -p`, so the first boundary covers every promotion, and the second enforces the hard rule that raw episodic text never enters the git-backed directory.

**It is not configurable.**
Hermes needs a `force=True` override at its compaction boundary because it has a user-facing toggle.
Not building the toggle is simpler and removes the failure where someone disables it and forgets.

**It scrubs credentials, not personal data.**
API key shapes, private key blocks, JWTs, cloud access keys, bearer tokens, connection strings carrying passwords, and nothing else.
A personal agent whose job is remembering that you are vegetarian cannot run a PII scrubber over its own memory without scrubbing the product.
This is a deliberate non-goal, not an oversight.

**The episodic log is not scrubbed on write, and the live reply path is not scrubbed at all.**
The log is the record of what was said, and scrubbing at write makes the agent unable to use a token the owner deliberately pasted.
The reply path already sends the conversation to a provider, which is the trust boundary the owner crossed by typing it.
What matters is that a credential never becomes durable: never in a fact, never in a brief, never in a digest, never in git.

**`redact` is purge with a different trigger**, for a key that slipped through a pattern gap.
Pattern matching has false negatives, and the design assumes it rather than pretending otherwise.

## Cold start renders nothing, and failures are visible

With an empty brief and no facts, the memory block is zero bytes.
Not a heading, not a "no memories yet" line, which is exactly what teaches a model to confabulate having some, and which costs prefix budget to say nothing.
Brief generation is not gated behind a session count: the brief holds the active task and open loops, which are useful from the third turn of the first session, and `NOOP` is a valid outcome for the first several reconcile passes.

Failure is graded by what is lost.

- **An episodic write that fails refuses the turn**, visibly. Everything downstream, digests, provenance and purge, assumes the log is complete.
- **A curated read that fails degrades to stateless and says so in one line.** Continuing silently means answering as if there is no history while the owner assumes there is.
- **A fact file that fails front-matter validation is quarantined**, not fatal. One malformed file must not take down a session.
- **A background pass that fails is reported, never swallowed.** Both reference systems wrap memory failures in empty catch blocks. A backend that has quietly stopped persisting is indistinguishable from one with nothing to say, and it is worse than no memory because the owner keeps relying on it.

That last one needs somewhere to report to, so cadence gets a **dedicated operator channel in the private guild**: background pass failures, purge confirmations, quarantined files, staleness evictions.
Both reference systems invent an operator channel by faking a user message into the transcript, which pollutes the record the log exists to keep honest.
A real channel costs nothing, since cadence already lives in a guild, and it doubles as how the owner sees what happened overnight.

Inspection needs nothing further: the facts are markdown files in a git repo the owner can read, grep and edit by hand, which is most of why they are markdown.

## Compaction, in three tiers with a derived threshold

The boundary is now where reconciliation fires, so when boundaries happen belongs to this design.

**Deterministic prune, re-measure, then digest only if still over.**
The prune rewrites old tool results to pointers with no LLM.
Hermes has both tiers and never re-measures between them, so on a tool-heavy turn where a few large file reads caused the growth, the prune alone routinely clears the threshold and it pays for an uncapped main-model summarisation anyway.
That is the single largest wasted latency in either codebase, and one measurement fixes it.

**The threshold is 70% of a reserve-adjusted budget**, where the reserve is max output plus thinking budget plus the measured incompressible floor of system prompt and tool schemas.
Deriving it fixes both reference bugs at once.
Pi's trigger at `window - 16,384` and its 20,000-token verbatim tail sum to 36,384, so on any smaller window compaction can never usefully fire and the session silently proceeds over budget.
Hermes's flat 50% strands 460K tokens of a 1M context that was already paid for, which is live for cadence specifically.

> **Amended by [ADR 0006](0006-model-routing.md).**
> The threshold is evaluated **after the reply is sent**, never while assembling a live turn.
> Crossing 70% on turn N sends the reply, then forms the boundary before turn N+1 assembles, which is what keeps the digest off the blocking path behind a semaphore of 1.
> The remaining 30% is the budget that pays for the deferral.
> A turn that overshoots anyway runs the deterministic prune alone and proceeds without a digest.

## Degradation order, as an input to routing

When the five-hour window is tight, passes drop in this order: playbook proposals, then the nightly sweep, then the brief pass, and reconcile-at-boundary last, because it is the only pass tied to information about to be irreversibly lost.

This ADR says what each pass is worth.
`#8` sets the budget, once `#15` produces a number for what a pass actually consumes.

> **Settled by [ADR 0006](0006-model-routing.md).**
> The order becomes a graded utilization ladder rather than a single cliff: playbooks at 60%, nightly sweep at 70%, brief at 80%, reconcile at 90%.
> It survives `#20`'s finding that this ADR's cost intuition was inverted, because shedding the brief pass at 80% sheds both the third-least-valuable pass and the most expensive one.
> Value order and cost order agree, so nothing reorders.

## What this does not solve

- **Propagated invalidation.** Bounded at 90 days, not fixed.
- **Key vocabulary drift.** Two contradictory beliefs can coexist under different keys, and no validation can catch a semantic duplicate. The reconciler sees the whole index, which helps and does not guarantee.
- **The affordability argument.** Every background pass assumes subscription-absorbed cost, and only that headless `claude -p` runs without an API key is verified. `#15` measures it.
- **Whether memory helps at all.** There is no benchmark to borrow, and the cheapest instrument found is a deterministic post-session check comparing the session's own top search terms against what reached context. Worth building, not decided here.

## Consequences

- `#11` is unblocked and inherits constraints rather than freedom: an append-only tree with full-text search for L2, a human-readable and diffable store for L3 to L5 whose history can be rewritten for one path, plus an audit table for purge, an archive, and a quarantine location.
- `#12` gains the operator channel as a required surface.
- `#8` gains the degradation order above, and the materiality check from ADR 0001 remains its other non-user-facing latency-bound job.
- `forget`, `purge` and `redact` are owner-facing commands, so the channel layer needs a command surface that is not a model tool call.
- Skills are back in scope as prose playbooks. Executable bodies are a later effort.
