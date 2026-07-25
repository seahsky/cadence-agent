# Facts are scoped to the person by default, with no precedence between scopes

Every memory read and write carries a scope key from the first commit, even though there is one operator today.
This records what that key is, what it defaults to, and what stops a call site bypassing it.

**Three levels: `user`, `channel`, `guild`.**
A fact defaults to `user`, so the private level is the default and the shared levels are a deliberate act.
Reads union across every applicable level; writes go to exactly one.
When facts at different levels disagree, both reach the prompt labelled with their scope and the model reasons about the combination.

## Why the person and not the channel

An earlier note proposed scoping the fact store to `(channel, author)`.
That has the defect already rejected one level down at the branch: tell cadence in `#health` that you are vegetarian and it suggests a steakhouse in `#general`.
Silent fragmentation is the reason per-branch scoping was refused, and the argument does not weaken one level up.

The privacy intuition also inverts on inspection.
In a channel with several people, **channel scope is the shared one and user scope is the private one**, because a channel-scoped fact is readable by everyone in the room while a user-scoped fact is keyed to whoever said it.
Channel-by-default would be the Hermes defect, one shared store across all users, with extra steps.

Channel and guild scope are for facts about the place, not the person: this room is for cooking, we use imperial here.
Those are worth having and are not what a fact defaults to.

## Why there is no precedence

Any total order over the levels is wrong for some real conflict.

| Conflict | `user` fact | `channel` fact | Wants |
| --- | --- | --- | --- |
| Units | prefers metric | `#us-recipes`: imperial here | channel |
| Verbosity | prefers concise replies | `#brainstorm`: long replies here | channel |
| A second person's claim | deadline is Friday | `#proj`: deadline is Monday | user, or neither silently |

Room-beats-person gets the third wrong, and gets it wrong invisibly: once a second human exists, their channel-scoped assertion quietly overrides something you told the agent privately.
Person-beats-room gets the first two wrong, so local conventions never take effect unless restated per channel, which is the fragmentation this decision exists to avoid.

Showing both, labelled, lets the agent say "you generally use metric, but this room is imperial, so imperial".
A precedence rule makes that impossible, because the losing fact never reaches the model.

Reversibility settles it.
Adding precedence later is a read-time filter and costs nothing.
Removing it later means facts have been silently dropped with no record of which ones.

Reconciliation therefore operates strictly within one scope.
No level can supersede or delete a fact at another level.

## The key's shape

A discriminated union in the type system, with one total function serialising to a namespaced string for storage and indexing.

```ts
type Scope =
  | { kind: "user";    platform: Platform; userId: string }
  | { kind: "channel"; platform: Platform; channelId: string }
  | { kind: "guild";   platform: Platform; guildId: string }
```

```
cadence:v1:discord:user:1234
cadence:v1:discord:channel:9876
cadence:v1:discord:guild:555
```

The two are answering different questions rather than competing.
A string is a good storage and index representation and a bad type: it offers no exhaustiveness, and building a wrong key by concatenation is the easiest mistake available.
The union gives an exhaustive `switch` at every call site; the serialiser keeps the version and platform segments that make the scheme changeable and keep Slack ids from colliding with snowflakes.

`(channel, user)` and `global` were both dropped.
Under "no precedence", `(channel, user)` covers nothing that a user fact plus a channel fact does not, and doubles the read set.
`global` collapses into `guild` while there is one guild, and adding a level later is just another row kind and another read.

## What enforces isolation

The database handle is module-private and never exported.
The only route to storage is a handle built from a resolved scope, and its methods take no scope argument at all.

```ts
resolveScope(inbound): { read: Scope[]; write: Scope }
openMemory(resolved): MemoryHandle   // facts(), search(q), put(fact)
```

One resolver produces the read set and the write scope together, because they have different arities and splitting them invites the silent failure.
A single-scope handle would force call sites to open three and merge, and forgetting one under-reads with no error, which is indistinguishable from a memory bug.

Search is a method on the handle rather than a free function, which is the part that matters.
The worst defect the research found in Hermes was an unscoped full-text transcript search returning any user's verbatim private messages: one forgotten `WHERE` on a `MATCH`.
Any design that guards fact lookup and leaves search taking a raw string has reproduced it exactly.

A required-`Scope` parameter was rejected because it stops a call site forgetting scope but not passing the wrong one, and the stated bar was that scope be a function the call site cannot bypass.
A lint rule was rejected because it enforces shape rather than meaning and is one unanticipated query shape away from the same defect.

Background passes need a second producer of scopes, since they have no inbound event.
It is named and auditable rather than ad hoc.

## No cadence-level identity yet

Platform-native ids are the identity.
Discord-you and a future Slack-you are different scopes and share no memory today.

This is a deliberate trade rather than an oversight, and the read set is why it is cheap.
A Person arrives later as a resolver change that returns two user scopes instead of one, with writes going to the platform-native scope.
Nothing on disk changes and no key is rewritten, so there is no migration to pay for by building the indirection now.
Building it now would mean a table with one row and a linking flow that cannot be inferred, and so would sit unbuilt and untested until Slack actually landed.
