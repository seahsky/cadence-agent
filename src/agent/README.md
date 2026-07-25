# agent

The loop: assemble a prompt, call a provider, run tool calls, decide when to stop.

Empty on purpose, and blocked further back than the other seams.
Whether cadence even *owns* a loop depends on the provider decision ([#7](https://github.com/seahsky/cadence-agent/issues/7)) — with `claude -p` the loop lives inside the subprocess, so cadence may end up with two execution models rather than one.

The loop internals and the v1 tool set are still fog on the map, not yet a ticket.
