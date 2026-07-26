# storage

Persistence for sessions and memory.

Empty on purpose, but no longer an open question.
[ADR 0005](../../docs/adr/0005-storage.md) settles the backend and schema; this directory fills in when the code lands.

**Two stores.**
SQLite (`$DATA_DIR/cadence.db`, via `node:sqlite`) holds everything append-only: the entry tree, sessions, attachment metadata, the purge audit and the write-ahead journal.
A single git repo (`$DATA_DIR/memory/`) holds the reconciled layers as markdown, because `purge` needs a history it can surgically rewrite and the owner needs a store they can read and edit by hand.
Attachment bytes are content-addressed in `$DATA_DIR/blobs/`, outside both.

Five constraints bind anything built here:

- **`memory/` has one branch, no merges, no tags, no remote, ever.** That invariant is the only reason `git filter-branch` is safe for purge, so the commit path maintains it rather than assuming it.
- **SQLite is the write-ahead log for git.** Record the intended commit, write the files, commit, clear. Without it a crash misattributes cadence's own half-written work to the owner.
- **Every mutation goes through one serialized queue.** One process, one writer, WAL.
- **Nothing in SQLite is derived from git.** The fact store is scanned, never mirrored, because it is hand-editable and a mirror is a cache nothing can invalidate.
- **Entries are scoped to the trunk channel**, and the scope predicate comes from the handle's closure per [ADR 0002](../../docs/adr/0002-memory-scope.md). No exported read path takes a raw predicate.

FTS5 is standalone with its own copy of the text, not external-content.
Verified on SQLite 3.50.4: an external-content delete against an already-blanked row silently leaves the term searchable, and `integrity-check` still passes.
That is the purge path, so it does not get a footgun.

Still true: nothing here gets a vector database. The read path is whole-index injection under a cap, so the architecture never asked for one.
