# runtime

The dispatcher. It subscribes to a channel's inbound source, owns the lifetime of a turn, and calls the agent.

Empty on purpose, and its shape is decided rather than open: [ADR 0007](../../docs/adr/0007-channel-abstraction.md).

Why it is not part of `agent/`: the agent assembles a prompt, calls a provider, runs tool calls and stops, which is a function of one request. What lands here is the in-flight registry keyed by session, per-session serialisation, and cancelling a turn when an edit supersedes the entry it was answering ([ADR 0001](../../docs/adr/0001-one-entry-tree-per-channel.md)). Those are lifetime concerns, and putting them in `agent/` would turn a function into a stateful service.

The channel never calls the agent and the agent never touches the channel. This is the only place that knows both exist.
