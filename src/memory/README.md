# memory

Short-term (the live conversation) and long-term (what cadence knows about you across sessions), plus the mechanisms that link them.

Empty on purpose, and it stays empty for this milestone.
The architecture is being *designed* now — see [issue #10](https://github.com/seahsky/cadence-agent/issues/10), fed by research into how [Hermes Agent](https://github.com/NousResearch/hermes-agent) and [Pi](https://github.com/earendil-works/pi) do it ([#5](https://github.com/seahsky/cadence-agent/issues/5)).

The implementation is explicitly out of scope for the current map. The deliverable is an ADR, not code.

Constraint that already holds regardless of the design: every read and write carries a scope key (`user` / `channel` / `guild` / `global`), enforced at the query layer rather than by convention, so opening cadence up to more than one person later is a config change and not a rewrite.
