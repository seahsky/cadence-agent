# cadence-agent

A personal AI agent reached through a chat surface.
It holds a conversation, remembers across conversations, and runs model work against more than one provider.

This glossary is channel-agnostic on purpose.
Discord is the only surface built today, but no term here is defined in terms of a Discord primitive.
How the model projects onto Discord belongs in `docs/adr/`, not here.

## Language

### Conversation structure

**Channel**:
A durable conversational place the agent is reachable in.
It outlives every session and every branch that occurs in it, and holds exactly one entry tree.
_Avoid_: room, surface, conversation

**Entry**:
One turn in a channel, recorded with a parent so that entries form a tree rather than a list.
_Avoid_: message, turn, event, node

**Trunk**:
The root branch of a channel's entry tree, the line every other branch ultimately descends from.
_Avoid_: main, root, base

**Branch**:
A path through the entry tree that diverges from another path at a fork point.
Branches never rejoin.
_Avoid_: fork, subthread, subtree

**Fork point**:
The entry a branch diverges from, and therefore the parent of that branch's first entry.
_Avoid_: branch point, split, divergence

**Revision**:
A branch that supersedes an entry rather than continuing from it, created when someone rewrites what they said.
Its fork point is the superseded entry's parent, which is what distinguishes it from an ordinary branch.
_Avoid_: correction, redo, retry, amendment

**Dead path**:
A path superseded by a later revision.
Retained so the record stays honest, never assembled into context.
_Avoid_: stale branch, orphan, history

**Session**:
A labelled span over a channel's entry tree, opened and closed by boundaries.
It is the unit consolidation runs over; it does not own a tree and does not contain the entries structurally.
_Avoid_: conversation, chat, dialogue

**Boundary**:
A node on a branch that substitutes a digest for everything above it on that path.
The same term covers a session roll and a mid-session compaction, because they are the same act.
_Avoid_: checkpoint, marker, watermark, compaction point

**Digest**:
The summary a boundary carries, computed only from the entries that boundary replaces.
Never computed from another digest, so summarising never compounds.
_Avoid_: summary, recap, compaction

**Branch summary**:
An account of what happened on a branch, written when it is abandoned and read by other branches.
Unlike a digest it replaces nothing; it exists so that one path can learn what another path did.
_Avoid_: thread summary, recap

### Memory

**Fact**:
A durable statement the agent believes, held at one scope and subject to being corrected or retracted.
Distinct from an entry, which is a record of what was said and is never revised.
_Avoid_: memory, belief, note, record

**Scope**:
The level a fact is remembered at: the person, the channel, or the guild.
A fact defaults to the person who said it, so the private level is the default and the shared levels are deliberate.
_Avoid_: namespace, partition, tenant, context

**Provenance**:
The pointer from a fact to the entry it was derived from, written by code and never supplied by a model.
It is what makes a wrong fact auditable and a deletion precise.
_Avoid_: source, citation, reference, lineage

**Brief**:
A short reconciled account of what a scope is currently doing: active task, open loops, commitments.
Held per scope and replaced wholesale, unlike a digest, which is computed once from the entries it replaces and never rewritten.
_Avoid_: summary, status, state, notes

**Playbook**:
A named procedure the agent can follow, held as prose so that reading the body is running it.
_Avoid_: skill, recipe, workflow, routine

**Index**:
The rendering of what memory holds that is always present in a turn, as opposed to what is read on demand.
_Avoid_: manifest, catalogue, listing, table of contents

**Working set**:
Everything assembled for one turn, in fixed order, computed rather than stored.
_Avoid_: prompt, context, payload

**Operation**:
One proposed change to a reconciled layer: add, update, invalidate, or nothing.
Proposed by a pass and applied by code, so a proposal is never a write.
_Avoid_: mutation, edit, action, command

**Reconciliation**:
The pass that reads what happened and proposes operations against what is currently believed.
_Avoid_: consolidation, reflection, review, learning

**Staleness sweep**:
The deterministic pass that reports which facts have gone unconfirmed long enough to fall out of the index.
Uses no model, which is why it is the one pass that cannot forget, and writes nothing, because ageing out is a property of the fact rather than a change made to it.
_Avoid_: decay, expiry, eviction, garbage collection

**Archive**:
The facts a scope holds that the index did not have room for: still searchable, never rendered into a turn.
A set rather than a place, since a fact crowded out today returns on its own once the facts ahead of it are retracted.
_Avoid_: cold storage, trash, attic

**Quarantine**:
Where a file goes when it fails validation, set aside so one malformed file cannot take down a session.
_Avoid_: corrupt, rejected, dead letter

### Model work

**Provider**:
A source of model completions cadence can send a turn to.
A hosted API and a local subprocess are both providers; neither owns a loop, tools, or any conversation state.
_Avoid_: model, backend, engine, LLM

**Turn**:
One request to a provider and the stream of events it produces.
Distinct from an entry, which is what a turn is recorded as once it is done.
_Avoid_: call, completion, request, generation

**Headroom**:
How much of a provider's allowance remains before it refuses work.
One term deliberately spans a subscription window and a per-token account, because routing needs to compare them.
_Avoid_: quota, rate limit, budget, credits
