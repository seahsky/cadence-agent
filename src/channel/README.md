# channel

Communication surfaces. Discord first; Slack, Telegram and CLI later.

The interface is decided: [ADR 0007](../../docs/adr/0007-channel-abstraction.md).

An adapter is **not a transport**.
It owns the projection onto the entry tree, so nothing above it knows what a thread is, and it owns rendering, so nothing above it knows which markdown dialect a platform speaks.

```
channel/            the seam: ChannelAdapter, Inbound, Notice, the three ports
channel/discord/    the adapter
channel/slack/      later, and it should touch nothing outside itself
```

Three rules the code has to keep:

- **No adapter declares capabilities.** Differences are papered over. An operation a platform cannot perform throws rather than silently no-ops, so a model-invoked `branch` on a CLI comes back as a tool error the model can work around.
- **An adapter imports neither `storage` nor `provider`.** It receives `EntryIds`, `EditJudge` and `Notify` as injected function-shaped ports, which is what keeps a database handle out of the channel layer and the routing policy out of a transport.
- **`origin.channelId` is the trunk channel id, never the thread id.** It is what a memory scope resolves from, and the adapter is the only thing that knows a thread's trunk.

The operator surface lives here too, as the `notify` field bound to a configured destination.
It is not a channel: it holds no entry tree, is never subscribed for inbound, and is never assembled into context.
