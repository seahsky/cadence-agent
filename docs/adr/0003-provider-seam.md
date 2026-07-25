# One narrow provider interface, with the subprocess provider refusing tools rather than ignoring them

`claude -p` is treated as a stateless completion endpoint that happens to be prepaid: always `--no-session-persistence`, no resume, nothing it writes on disk is ever read back, and cadence passes full context on every call.
With the statefulness declined, a subprocess and an HTTP API genuinely are the same shape, so the seam is a single `stream()` with no capability flags.

```ts
interface ModelProvider {
  readonly id: string;                       // "openrouter" | "claude-cli"
  stream(req: TurnRequest, opts?: TurnOptions): AsyncIterable<TurnEvent>;
}
```

That holds for state.
This ADR records the three places it does not hold on its own, and what each one costs.

## Tools are a capability, not an option

The interface's own rule is that options a provider cannot honour are ignored rather than rejected.
That rule is right for tuning and wrong for tools.

`claude -p` always runs `--tools "" --strict-mcp-config`, so it is a pure reasoning engine that never emits a tool call.
The only way to give it cadence's tools is to wrap them in an MCP server and pass `--mcp-config` per invocation, which makes it execute them itself.
That would make a `tool_call` event mean "you must run this" for one provider and "already ran" for the other, which is the one place the research warned a unified interface genuinely leaks, plus MCP startup on every call.

So the subprocess provider **throws** when handed a non-empty `tools` array.

Ignoring `temperature` changes the quality of a turn.
Ignoring `tools` changes what the turn is: you asked for a loop step and got a monologue, silently, in production.
A declared `supportsTools: false` flag was rejected as reintroducing exactly the capability-flag shape this seam removed, and as duplicating knowledge the routing config already has to hold.

**Consequence for routing.** `claude -p` can never serve a tool-capable turn, so failover between the two providers applies to background work only.
Tool-free does not mean structure-free: the consolidator returning JSON operations works by prompting.

## Headroom is a shared concept, and the error type has to grow

Mapping `stream-json` onto `TurnEvent` is mechanical.
Hook events are Claude Code's own lifecycle and get dropped, `system/init` becomes `start`, partial assistant messages become text deltas, `result` becomes `done`.
Tool events never occur.

`rate_limit_event` looks like an orphan and is not.
Both providers answer "how much headroom is left", in different shapes: a five-hour window with a `resetsAt` on one side, `X-RateLimit-Remaining` and `limit_remaining` on the other.
So it normalises onto a `headroom` field on `done` rather than earning a new event variant, which nothing could act on mid-turn anyway since routing decisions are made before a call from the state of prior calls.

`TurnEvent.error` carrying only `"error" | "aborted"` cannot distinguish a quota denial from a crash, and failover needs that distinction.
It gains a typed cause, normalised onto the vocabulary OpenRouter already publishes as a canonical typed error code stable across providers.
`status: "denied"` from `claude -p` and a 429 from OpenRouter both map to `quota`.

`TurnOptions.sessionId` survives on OpenRouter cache stickiness alone, which is enough: prompt caching is the difference between a viable and a non-viable agent economically, and cadence's prefix carries a brief, a fact index and branch pointers that all move, so the default routing key of hashing the first system and first non-system message goes cold.
It is renamed **`cacheKey`**, because `session` now means a span over the entry tree and the two concepts must not share a name.
Its value is the session id, which is stable across exactly the span where the prefix is stable.

## Processes are one-shot

Spawn per invocation, write the prompt, read events, exit.
A global semaphore defaulting to concurrency 1, because the five-hour window is one shared resource.
A 120 second timeout that kills the process group and surfaces as a retryable cause.

Reuse is not a trade-off, it is a contradiction.
A long-lived process fed through `--input-format stream-json` processes messages sequentially and remembers, so with cadence re-sending full context every call the model would see the earlier context twice.
That is the statefulness this design declined, back again in memory.

Pre-warmed one-shot processes would recover the roughly 500ms startup without any state, and were rejected as optimising a path that does not need it: every job routed here is asynchronous, and the one latency-bound tool-free job in the design goes to the cheap HTTP model.

**The provider never fails over.**
It reports `cause: "quota"` honestly and stops.
Routing and failover live above it, or real spend is hidden and cost attribution lies.

## One accounting trap

`total_cost_usd` from `claude -p` is what the work would have cost at API prices.
There is no API account to bill, so it is accounting and not a charge.

It belongs in a separate `notionalCost` field with `cost.total` at zero, so subscription window consumption can be tracked from it without it ever being summed into real OpenRouter spend.

## Open, and measured elsewhere

Whether `claude -p` emits thinking deltas under `--include-partial-messages` is unverified, and decides whether `thinking_delta` is reachable from this provider at all.
Concurrency and per-pass window cost are guesses until `#15` runs, at which point the semaphore and timeout defaults get set from a number.
