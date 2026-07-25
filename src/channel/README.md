# channel

Communication surfaces. Discord first; Slack, Telegram and CLI later.

Empty on purpose.
The interface a channel must implement is an open decision — see [issue #12](https://github.com/seahsky/cadence-agent/issues/12), which is blocked on the Discord constraints research ([#4](https://github.com/seahsky/cadence-agent/issues/4)) and the session-boundary decision ([#9](https://github.com/seahsky/cadence-agent/issues/9)).

Writing the interface before those close would mean guessing at it, and a channel abstraction guessed from one channel is the thing most likely to need a rewrite when the second arrives.

What lands here eventually: the normalised inbound-message shape, the outbound send/edit/typing surface, per-channel capability declarations, and the Discord adapter itself.
