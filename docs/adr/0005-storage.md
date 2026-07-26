# Two stores: SQLite for what only ever grows, a git repo for what changes its mind

ADR 0004 cut memory on append-only versus reconciled and handed storage two shopping lists that do not want the same engine.

The episodic log needs an index over a tree that is never mutated, with scope-closed full-text search and no full-file scan.
The reconciled layers need to be human-readable, diffable, editable by hand, and to keep a complete history whose one path can be surgically rewritten, because `purge` has to destroy a record and then prove it destroyed it.

No single store gives both without building the other half yourself.
A database would need a versions table, a diff renderer and an editing surface to imitate what git already does.
A git repo alone dies on the ADR's own requirement that search not be a full-file scan.

**So: SQLite for the log, sessions and every index; one git-backed markdown repo for the brief, the facts and the playbooks.**

The price is an enforceable `src`.
With one store, a fact's provenance pointer would be a foreign key the database checks.
Across two, nothing checks it, which turns out to matter only under one specific failure and is dealt with under "The two stores stay in step" below.

## What is on disk

```
$DATA_DIR/
  cadence.db                                   SQLite: entries, sessions, attachments, audit, journal
  blobs/<sha256>                               attachment bytes, content-addressed, not in git
  memory/                                      one git repo, every scope
    facts/discord/user/1234/home-city.md
    brief/discord/user/1234.md
    playbooks/discord/user/1234/deploy-check.md
    quarantine/...
```

**The database sits outside the repo rather than inside it gitignored.**
A `git add -A` that swallows a growing binary is a real accident, and WAL and SHM files churning under `git status` is noise bought for nothing.
Nothing about an append-only log wants version control.

**One repo for every scope, not one per scope.**
Per-scope repos would make creating a scope a `git init`, multiply the lock surface, and turn a nightly sweep across several scopes into N repo operations.
The isolation they would have bought is recovered at the directory level instead: everything about one person is one directory, and `git filter-branch` over a single path is already as surgical as purge needs.
What per-scope repos gave structurally, a single repo gives by rule, so the rule is enforced in the commit path rather than left as a convention: **every commit touches exactly one scope.**

### A scope has two representations

ADR 0002 serialises scope to `cadence:v1:discord:user:1234`.
That is a good index key and a poor directory name, so there are two total functions in the scope module and neither is ever inlined at a call site.

| | Form | Used by |
| --- | --- | --- |
| `toKey(scope)` | `cadence:v1:discord:user:1234` | SQLite columns and indexes |
| `toPath(scope)` | `discord/user/1234/` | paths inside the git repo |

The `cadence:v1:` prefix does not survive into the path.
It namespaces an index shared with nothing, and the version segment is already carried once by the store-level `schemaVersion`; encoding it twice creates two things that have to agree.

## Nothing in SQLite is derived from git

The fact store is **scanned**, not indexed.
There is no `facts` table mirroring front-matter, and no filesystem watcher.

The arithmetic allows it.
Under ADR 0004's 2,000-token cap the live fact set is tens of files per scope, front-matter only, and a render happens when memory changes rather than every turn.

The stronger argument is that a mirror is a cache over a store deliberately made hand-editable.
The owner edits a file in their editor, or reverts a bad reconcile pass, and an index in SQLite now disagrees with disk with nothing able to detect it.
Keeping it honest costs a watcher or a startup reconcile, which are two new failure modes bought to speed up a scan of forty files.

The one thing this gives up is real: `UNIQUE(scope, key)` would make a duplicate `ADD` impossible, where a scan makes it merely unlikely, checked by the same code that would have to remember to check.
ADR 0004 already puts that check in code, so this changes what enforces it and not whether it is enforced.

## The git repo is a machine with one branch

Cadence shells out to system `git` through `node:child_process`.
No wrapper library: `simple-git` buys string formatting, and `isomorphic-git` cannot rewrite history at all, which disqualifies it on the single operation that matters most.

**One commit per pass, not per operation.**
A reconcile pass that emits three operations made one decision, and splitting it into three commits invents a sequence that never happened.
Per-file audit survives either way, since `git log -- <path>` does not care how commits were batched, and purge does not care either: `filter-branch` strips a path out of every commit it appears in and leaves the rest of each commit intact.

Messages are machine-written and never model-written:

```
reconcile(discord:user:1234): UPDATE home-city, ADD commute-mode
```

**Hand-edits get their own commit.**
The store is deliberately editable, which makes the owner a third author git has to attribute.
A pass stages only the paths it wrote; before it commits, dirt on any path it did not write is committed first as `owner: manual edit`.
Staging `-A` instead would land the owner's edit inside a commit labelled `reconcile`, and the audit trail would lie about which belief changed and who changed it.

### Purge rewrites history with filter-branch, under an invariant

`git filter-repo` is the tool git's own documentation points at, and it is not installed here: it is a separate Python script, not shipped with git.
`filter-branch` is bundled, and prints a deprecation warning about mangled rewrites.

**Every gotcha in that warning describes a repo shape this store cannot have.**
The warnings are about merges, tags, multiple branches, and history other people have already pulled.
This repo has one branch, no merges, no tags, no remote, and every commit is machine-authored and linear.

That turns the deprecation into a precondition, so it is maintained rather than assumed:

> **Single branch. No merges. No tags. No remote. Ever.**

Purge is `git filter-branch --index-filter 'git rm --cached --ignore-unmatch -- <path>'` followed by expiring the reflog and pruning, and it is rare, owner-triggered, and reports to the operator channel when it finishes.
A minute of process spawns is an acceptable price for not requiring a Python binary whose absence would be discovered at the worst possible moment, which is the instant the owner asked for something to be destroyed.

The invariant has a consequence that catches you elsewhere: **the pre-migration marker cannot be a tag.** It is a commit sha recorded in SQLite.

## The database

`node:sqlite` on Node 22.19 ships SQLite 3.50.4 with FTS5 compiled in and a real `backup` API, and it emits `ExperimentalWarning: SQLite is an experimental feature and might change at any time`.

It is kept anyway, behind one narrow module-private wrapper exposing `prepare`, `exec` and a transaction helper and nothing else.
The wrapper has to exist regardless, because ADR 0002 requires the handle be module-private and reachable only through a resolved scope, so the insurance against an API shift is free.
If the warning ever becomes a breakage, `better-sqlite3` is a one-file swap, which is a better position than paying for a native build step today against a risk that has not materialised.

```sql
entries(id, parentId, scopeKey, sessionId, kind, authorId, body, payload,
        createdAt, platformMessageId, tombstonedAt)
entries_fts(body)                          -- standalone FTS5, own copy of the text
sessions(id, scopeKey, label, startedAt, endedAt, boundaryEntryId)
attachments(entryId, sha256, filename, mime, size)
purge_audit(key, scopeKey, requestedBy, at)          -- never content
pending_commit(id, message, paths)                   -- see the next section
```

**One `entries` table with a `kind` discriminator.**
Digests are nodes in the tree per ADR 0001, and a `parentId` walk that has to UNION across tables at every hop is worse for nothing.
A tombstone is a **state** of an entry rather than a kind: `body` nulled, `tombstonedAt` stamped, `id` and `parentId` preserved, exactly as ADR 0004 requires so tree walks and digests survive a purge.

**Code syncs the FTS index, not triggers.**
Code is already the only writer, and a trigger is a second writer that is invisible at every call site.

### Standalone FTS5, because external-content fails silently on the purge path

Verified on SQLite 3.50.4:

| | Behaviour |
| --- | --- |
| Standalone `fts5(body)` | `DELETE FROM entries_fts WHERE rowid = ?` removes the terms. |
| External-content, row intact | `DELETE` works: FTS reads the content row to find the terms. |
| External-content, row blanked first | The delete silently indexes nothing. **The term stays searchable and `integrity-check` passes.** |

External-content is the idiomatic choice and halves the storage of text.
It also makes purge correct only if one ordering rule is remembered, and makes violating that rule undetectable by any check SQLite offers.
A standalone table stores its own copy, costs roughly 2x on text at personal scale, and has no ordering dependency at all.

This is the same reasoning as the filter-branch invariant, applied the other way: prefer the option whose correctness does not rest on remembering a rule, unless the rule can be made a precondition the code maintains.
Here it cannot, because the rule lives inside whichever function happens to tombstone next.

### An entry is a Discord message, not a model message

One turn produces one inbound message, some tool calls and results, and a reply.
Discord shows two messages; the model transcript has six.

**The tree's nodes are the messages.**
Branches fork from a message, which is the whole navigation model in ADR 0001, so a node nobody can start a thread on does not belong in a tree whose entire UI is Discord's own message list.

Each entry therefore carries both `body`, the human-readable text, and `payload`, the full model-level message array including tool calls, as JSON.
**Only `body` is indexed.**
Indexing tool output would fill the index with file contents and API responses, and make a search for something someone said return a hit inside a JSON blob.

Two things this settles.
**Entry ids are cadence's**, because digests have no message behind them and revisions need their own identity; `platformMessageId` is a nullable column.
And **the prune does not contradict append-only**: ADR 0004's deterministic prune rewrites old tool results to pointers in the assembled working set, which ADR 0004 already defines as a pure function of the tree.
The stored `payload` keeps the full results forever.

### Entries are scoped to the trunk channel

ADR 0002 fixes three scope levels but is written about facts, and search over the log is where the defect it exists to prevent actually lived.

**An entry's scope is the channel it was posted in, and the channel is the trunk, never the thread.**

Scope is about who may read, and everyone in the room already saw the message, so the author is an ordinary `authorId` column: attribution, not access.
Scoping by author would make a shared channel's history invisible to everyone but its writers, which breaks the ordinary case of recalling what the room discussed.
Trunk rather than thread follows ADR 0001's rule that scope resolves from the session and never from the branch, so a search from the trunk finds what happened in its branches.

For the log the three-level union collapses to one level, since nobody posts a message to a guild and every message in a guild-first design lands in a channel.
`search()` filters on exactly one key.

**Cross-channel search is given up.** Ask in one room what you said in another and cadence cannot see it.
That is the Hermes leak prevented structurally rather than by a `WHERE` clause someone has to remember, and the facts layer is the thing that is supposed to carry knowledge between rooms.

Enforcement remains code discipline: `DatabaseSync` exposes no authorizer hook, so there is no engine-level way to make an unscoped query impossible.
The storage module exports one read path that appends the scope predicate from its closure, and no route that accepts a raw predicate.

### Attachment bytes are stored, content-addressed

`docs/research/discord-channel-layer.md` establishes that CDN URLs are signed and expiring, so a persisted URL rots.

Bytes go to `blobs/<sha256>`, outside the git repo, with metadata in `attachments`.
Outside git because binaries make the history rewrite purge depends on slow and large, and content-addressing gives deduplication for free when the same image is posted twice.
Purge deletes a blob by hash once no live row references it, which is a plain `rm` and strictly easier than the git path.

Storing them is what keeps the log complete, which everything downstream assumes.
A branch forked off a year-old message with an image would otherwise assemble context with a hole in it that raises no error.
Discord's default ceiling is 10 MiB; anything larger gets a metadata row marked too large, so the fact that an attachment existed is never silently dropped.

## The two stores stay in step

**One process, one serialized write queue, WAL.**
Every mutation of either store goes through the same queue, which also means git's `index.lock` can never contend with itself.
Background passes are `claude -p` subprocesses that emit JSON and cadence's own code applies it, and `forget`, `purge` and `redact` arrive through Discord, so there is never a second writer.
The synchronous driver blocking the event loop is not a concern at these sizes against a heartbeat interval measured in tens of seconds.

**SQLite is the write-ahead log for the git side.**

```
BEGIN; INSERT INTO pending_commit(id, message, paths); COMMIT
write the files
git add <paths> && git commit
DELETE FROM pending_commit
```

Without this, a crash between writing files and committing them leaves dirt in the working tree that the next pass would attribute to the owner, by the hand-edit rule above.
Cadence's own half-finished work would be recorded as yours, permanently, in the trail that exists to say who changed what.

On boot and before any pass runs, a non-empty `pending_commit` is committed with its recorded message first, and only then does the owner-dirt check run.
It is idempotent: a crash after the commit finds nothing staged and simply clears the row.

**Recovery rolls forward.**
A crash partway through the file writes leaves a partially applied batch, and the files that landed are each independently valid, because the file is the fact and a batch's operations do not depend on each other.
Committing what is there and reporting the recovery to the operator channel is preferred to discarding reconciler work silently.
The cost is that "a pass applies atomically" is not a property that can be stated without qualification.

This also settles provenance.
A pass reads entries that are already durable before it writes a fact naming them, so `src` can never point forward at something unwritten.
A dangling `src` is reachable only by restoring the two stores from different moments, which makes it a backup problem.

### A backup is one snapshot of everything

**The unit is the whole `$DATA_DIR`, captured at one instant.**
Not the database and then the repo: facts name entries through `src`, and halves captured seconds apart restore into facts pointing at entries that were never written, which is exactly the case purge then silently misses.

Consistency is nearly free because the write queue is ours.
Pause it, run `backup()` on SQLite plus a copy of `memory/` and `blobs/`, resume.

**Purge destroys the live copy immediately; backups age out on their retention clock, and the confirmation says the date.**

ADR 0004 justifies rewriting git history on the grounds that this is a local store with no remote and nothing sharing its history, and a backup is a copy of that history.
Naming the conflict rather than leaving it implicit: the guarantee purge makes is "destroyed from everything cadence reads, now, and from disk entirely by <date>", and the operator channel says so rather than letting the word do work it cannot.

Deleting every backup generation on purge would make the guarantee unconditional and cost the entire restore history, which trades a recovery you will plausibly need, after a bad reconcile pass, against a disk-access threat a single-operator box mostly does not face.
A backup is never read by cadence, so a generation holding a destroyed fact cannot feed it back into a reply, which is the threat ADR 0004 built purge against.

## Nothing moves, so there is no archive

ADR 0004 gives a fact three ways out of the rendered block, and they are not the same kind of thing.

`INVALIDATE` is a state transition that stamps two fields and leaves the file in place.
The 2,000-token cap is not a state at all: eviction is deterministic, oldest `asof` first, recomputed whenever memory changes.
The 90-day staleness rule is a predicate over a field that already exists.

**A fact evicted by the cap must be able to come back**, the moment some of the newer facts crowding it out are invalidated.
Moving it into an archive directory turns a recomputed selection into a sticky one-way transition, and then requires a promotion mechanism that has to re-derive exactly the ranking the render already computes.

So facts live in `facts/<scope>/<key>.md` for their whole life.
The render selects under the cap; **"never injected" is what the render did not select, not a place it was moved to.**
Search covers every fact file in the read scopes regardless of whether it rendered, which satisfies "stays searchable" with no second location for purge to remember.

**Quarantine is a real location** and stays one, because a file that fails front-matter validation has to move out of the way or every later scan trips on the same file.

## Change, and what happens when writing fails

**SQLite migrations are forward-only**, an ordered array of functions keyed on `PRAGMA user_version`, run at boot in a transaction with a `backup()` taken first.
Down migrations get written once, never tested, never run; restoring the backup is the rollback that works.

**Markdown gets one store-level `schemaVersion`, not per-file front-matter versions.**
A markdown migration rewrites the affected files and commits once as `migration: v2 to v3`, running before the owner-dirt check so hand-edits are never swept into it.
Per-file versions buy a mixed-version directory that every read site then has to support forever, with no forcing function to finish a migration.

### A broken git repo stops background writes

Because the files land in the working tree before the commit, a failed commit leaves memory live and correct and only the history missing.
That looks harmless until it is read against ADR 0004's own justification: there is no approval gate on background fact writes, and **git history is the accountability instead**.
If git cannot record them, unattended background writes have lost the thing that made them acceptable.

| Failure | Response |
| --- | --- |
| Commit fails | Files already live. `pending_commit` row stays, next pass retries. One operator-channel alert per streak, not per attempt. |
| Three consecutive commit failures | Git declared unhealthy. Reconcile, brief and staleness passes stop proposing writes. Reads untouched. |
| Explicit "remember this" | Still writes. ADR 0004 calls an owner-present write the safest moment a write ever happens; it has a human as its accountability and never needed git. |
| File write fails | Pass fails outright, `pending_commit` cleared, reported once. |
| Episodic write fails | Refuses the turn, per ADR 0004 unchanged. The log must be complete. |

Cadence keeps answering with everything it already knows when git is unhealthy.
It stops learning.

## Inspection builds nothing

Facts are files in a git repo, which is most of why they are markdown.

**The log is Discord.**
The episodic log is the conversation, and the owner already has a first-class searchable client for it; cadence's copy is a mirror, not the original.
Building a viewer means rebuilding Discord badly for an audience of one.

What cadence adds beyond what Discord shows is a short list: digests, session boundaries, tombstones, staleness transitions, purge confirmations.
Those go to **the operator channel** as they happen, which ADR 0004 already establishes, and which Discord then keeps forever.
`purge_audit` is a content-free table nobody will query; the operator-channel message is the copy that gets read.

Facts are files, the log is Discord, everything else is the operator channel.
There is no third surface, no CLI, no export command.
Reading the tree by parent pointers is debugging rather than inspection, the audience is one person with `sqlite3` on the box, and building for it before a single session has run is speculative.

## Two amendments to ADR 0004

- **The staleness sweep produces no operations.** ADR 0004 lists it in the four-producers table. Under "Nothing moves" it observes transitions and reports them to the operator channel, and writes nothing. It is still the one pass that cannot forget, and it is no longer a writer.
- **"Archive" is not a location.** ADR 0004 reads as a move, "what leaves the rendered block goes to an archive". It is the set of live facts the render did not select.

## Consequences

- **The filter-branch invariant binds later work.** No branch, merge, tag or remote may ever be created in `memory/`. That rules out backup-by-push, tagging releases of the memory store, and any future multi-writer arrangement, and it must be checked in the commit path rather than trusted.
- **Cross-channel log search does not exist**, and anything that wants knowledge to travel between rooms has to go through facts.
- `#12` gains two required surfaces, both already implied by ADR 0004 and now load-bearing for storage: the operator channel carries git-unhealthy alerts, recovery notices, quarantine notices and purge confirmations with their retention dates, and the command surface for `forget`, `purge` and `redact` is not a model tool call.
- **`CONTEXT.md` changes twice**, for **Archive** and **Staleness sweep**.
- The memory implementation effort inherits a schema rather than a question, and inherits no inspection tooling on purpose.
- **Nothing here provisions a vector store.** The read path is whole-index injection under a cap, so the architecture never asked for one, and grep over markdown has not yet been shown to lose.
