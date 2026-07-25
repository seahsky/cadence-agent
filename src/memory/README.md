# memory

The reconciled layers: the brief, the facts, and the playbooks, plus the passes that propose changes to them.

Empty on purpose, and it stays empty for this milestone.
The architecture is settled in [ADR 0004](../../docs/adr/0004-memory-layers.md) and the implementation is a follow-up effort.

Three constraints from that ADR bind anything built here:

- **Code is the only writer.** Every pass proposes operations (`ADD` / `UPDATE` / `INVALIDATE` / `NOOP`) and cadence's own code validates and applies them. Caps are enforced on write, never requested in a prompt.
- **Every read and write carries a scope key**, per [ADR 0002](../../docs/adr/0002-memory-scope.md), resolved once and closed over. Memory tools take no scope argument at all.
- **Nothing durable holds a credential.** One scrub function runs before anything leaves for a subprocess and again before any file write.

The episodic log is not here.
It is append-only and belongs with storage; this directory is only the side of memory that can contradict itself.
