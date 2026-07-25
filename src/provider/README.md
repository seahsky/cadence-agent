# provider

Model backends. Two of them, and they are not the same kind of thing:

- **OpenRouter** — a stateless HTTP model API, billed per token. Cadence owns the loop and the context.
- **`claude -p`** — Claude Code headless, billed against a subscription. It owns its own loop, its own tools, and its own context compaction.

Empty on purpose.
Reconciling those two shapes behind one seam is the sharpest open question on the map — see [issue #7](https://github.com/seahsky/cadence-agent/issues/7), blocked on the two provider research tickets ([#2](https://github.com/seahsky/cadence-agent/issues/2), [#3](https://github.com/seahsky/cadence-agent/issues/3)).

The risk to avoid: an interface that pretends a stateless completion API and a stateful subprocess agent are interchangeable. That leaks immediately.
