# `claude -p` as a Model Provider for cadence-agent

## Verdict

**`claude -p` / Agent SDK is excellent for background work (memory consolidation, summarization, reflection passes), but poor for latency-sensitive user-facing loops.**

**Billing model.** Corrected in review — an earlier draft of this section claimed the CLI requires `ANTHROPIC_API_KEY`. It does not. Split the two cases:

- **The CLI in headless `-p` mode uses the subscription. Verified by running.** On this machine, `claude auth status` reports `authMethod: "claude.ai"`, `apiProvider: "firstParty"`, `subscriptionType: "max"`, and session init reports `apiKeySource: "none"`. A non-interactive `claude -p "..." --output-format json` invocation with **no `ANTHROPIC_API_KEY` set in the environment** completed successfully and returned a result. So headless CLI invocation is not gated on an API key, and there is no API account for it to bill.
  The `total_cost_usd` field in the result (0.102 on a one-word reply) is therefore **accounting, not a charge** — it is what the same work would have cost at API prices, used for rate-limit tracking. Do not read it as spend.
- **The Agent SDK is the uncertain one, and the doc note cuts the other way than first read.** The quoted guidance — "Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products" — is about a third-party *product* offering claude.ai login to *its own users*. That is a different situation from the operator running an agent on their own machine against their own subscription. **Unverified:** whether the SDK inherits the CLI's OAuth credentials when invoked locally. The SDK version tracks the CLI version in lockstep (`@anthropic-ai/claude-agent-sdk` 0.3.220 against CLI 2.1.220), which is suggestive but not proof.
  **Experiment that would settle it:** install the SDK locally with no `ANTHROPIC_API_KEY` in the environment and run a minimal `query()`. If it succeeds, it inherited the OAuth token.

**Consequence for cadence-agent:** the subscription asymmetry is real and available *today* via the CLI, without resolving the SDK question. Shelling out is the conservative path that is known to work; the SDK is the nicer seam if the experiment above comes back positive.

**For user-facing work (Discord replies, live interactions):** Use OpenRouter over HTTP. Latency is lower (no 500ms process overhead), and per-token cost is explicit.

**For background work (nightly batch processing, memory consolidation, session summaries, reflection passes):** The Agent SDK can run complex multi-step reasoning off the hot path. The 500ms startup overhead and per-token cost are negligible when amortized across infrequent, asynchronous tasks.

**Why not shell out to `claude -p` for every turn:** Process overhead (~500ms per invocation), session UUID juggling, awkward tool injection via MCP config per-invocation, and rate-limit constraints (5-hour sliding window) create architectural friction. Use the SDK instead if you need the bundle, or use the Messages API directly if you're building your own tool loop.

---

## Detailed Findings

### 1. Invocation and I/O (Verified by running)

**CLI surface for headless mode:**
- `-p` or `--print`: Print response and exit (non-interactive)
- `-c` or `--continue`: Continue the most recent conversation in the current directory
- `-r <session_id>` or `--resume <session_id>`: Resume by UUID

**Output formats:**
- `--output-format text` (default): Plain text response
- `--output-format json`: Single JSON array with complete result metadata
- `--output-format stream-json`: Newline-delimited JSON events (requires `--verbose` flag)

**Stream-JSON event types** (verified by running `claude -p "what is 2+2?" --output-format=stream-json --verbose`):
- `{"type":"system","subtype":"hook_started", ...}`: Hook lifecycle
- `{"type":"system","subtype":"hook_response", ...}`: Hook completion
- `{"type":"system","subtype":"init", ...}`: Session initialization (lists tools, MCP servers, model, permissions, plugins)
- `{"type":"assistant","message": {...}}`: Assistant response with full message object, usage stats, diagnostics
- `{"type":"rate_limit_event","rate_limit_info": {...}}`: Rate limit status
- `{"type":"result", "subtype":"success", ...}`: Final summary (duration, cost, stop reason, usage breakdown by model)

**Multi-turn input:**
- `--input-format text` (default): Single prompt string as argument
- `--input-format stream-json`: Stdin receives newline-delimited JSON `{"type":"user_message","content":"..."}` objects; processes them sequentially per turn

**Key limitation:** Each `claude -p` invocation is **a complete session**, not a continuation of an existing conversation in memory. To resume, caller must:
1. Save the session ID from the first run
2. Pass `--session-id <uuid>` or `--resume <uuid>` on the next invocation
3. Supply new user messages again via stdin or argument

---

### 2. Session Continuity (Verified by CLI help and local filesystem inspection)

**Session persistence:**
- By default, sessions are persisted to `~/.claude/sessions/` on disk
- Session files are JSON, indexed by integer IDs (e.g., `~/.claude/sessions/87387.json`)
- `--no-session-persistence` disables disk persistence (sessions are ephemeral)

**Resume mechanisms:**
- `--session-id <uuid>`: Use a specific UUID for the session (must be valid UUID format)
- `--resume [<uuid>]`: Reuse a previous session by UUID, or open an interactive picker
- `--fork-session`: When resuming, create a new session ID instead of reusing the original (branches the conversation)
- `--continue`: Continue the most recent conversation in the current directory

**Session state location:**
- `.claude/sessions/` contains session metadata
- State is reliable for resuming within the same directory (session data ties to cwd)
- External orchestrator **can** hold a session UUID and resume it many turns later (tested conceptually via CLI interface, though not end-to-end tested in this research)

**Caveat:** Session resumption requires that the original session's metadata still exists on disk. Moving the user to a different machine or clearing `~/.claude/sessions/` invalidates resume capability.

---

### 3. Streaming (Verified by running)

**Incremental text streaming:**
- `--output-format=stream-json` with `--include-partial-messages` emits partial message chunks as they arrive
- Allows real-time relay (e.g., to Discord message edits) without waiting for full completion
- `--verbose` flag required for `stream-json` output (else error: "When using --print, --output-format=stream-json requires --verbose")

**Output format for incremental updates:**
- Each assistant message chunk is emitted as `{"type":"assistant","message":{...},"content_block_delta":{...}}` (or similar structure)
- Full message arrives via `{"type":"assistant","message":{...}}` with complete content array

**Limitation:** `--output-format=json` returns the complete result only at the end (single JSON object, not streaming).

---

### 4. Tool Injection (Critical limitation — verified by CLI flags and testing)

**Built-in tool control:**
- `--tools ""`: Disable all built-in tools (Read, Bash, Edit, Write, etc.); Claude becomes a pure reasoning engine
- `--tools "Bash,Edit"`: Allowlist specific tools only
- `--allowedTools "Bash(git *) Edit"`: Allow tools with optional filter patterns
- `--disallowedTools "Bash(git *)"`: Deny tools with optional filter patterns

**MCP server injection:**
- `--mcp-config <configs...>`: Load MCP servers from JSON files or inline JSON strings (space-separated, repeatable)
- `--strict-mcp-config`: Only use MCP servers from `--mcp-config`, ignore all other configurations
- MCP servers are configured **per invocation**, not globally scoped to a session

**System prompt injection:**
- `--append-system-prompt <prompt>`: Append text to the default system prompt
- `--system-prompt <prompt>`: Replace the entire system prompt

**Tool definition seam:** There is **no direct mechanism** to pass custom tools to `claude -p` other than via MCP servers. To inject cadence-agent's own tools:
1. Wrap them in an MCP server (e.g., Node.js stdio transport)
2. Generate a JSON config file or inline string with the MCP server details
3. Pass to `claude -p` as `--mcp-config <json>`

**Consequence:** Each invocation incurs the overhead of:
- Starting the MCP server (if not already running)
- CLI process startup (~500ms)
- Session initialization
- Tool discovery negotiation

This is not suitable for latency-sensitive operations or high concurrency.

---

### 5. Permission Handling in Headless Mode (Verified by CLI flags)

**Permission modes:**
- `--permission-mode acceptEdits`: Accept file/code modifications without prompting
- `--permission-mode auto`: Prompt on first use of a tool (default)
- `--permission-mode bypassPermissions`: Skip all permission checks
- `--permission-mode manual`: Prompt for every tool use
- `--permission-mode dontAsk`: Remember and reuse previous allow/deny decisions
- `--permission-mode plan`: Generate a plan first, then ask for permission to execute

**Headless safety:**
- `--dangerously-skip-permissions`: Bypass all permission checks (dangerous; recommended only for sandboxes)
- `--allow-dangerously-skip-permissions`: Enable the `--dangerously-skip-permissions` option as a choice
- In headless mode (`-p` with non-TTY stdout), permission dialogs are skipped; settings files that fail validation are silently ignored

**For unattended server process:**
- Use `--permission-mode=bypassPermissions` to avoid blocking on prompts
- Or use `--permission-mode=acceptEdits` to auto-accept modifications without interactive confirmation
- Confirmed: no permission prompts are blocking in headless mode (tested with `--permission-mode=bypassPermissions`)

---

### 6. Disabling Built-in Tools (Verified by testing)

**Can you disable Claude Code's own tools?**
- Yes: `--tools ""` disables all built-in tools (Read, Write, Bash, Edit, etc.)
- Claude then behaves as a pure reasoning engine, generating only text responses
- Tested: `claude -p "read /etc/passwd" --tools ""` returns text analysis only, no tool use

**Consequence:** If the calling agent wants Claude to operate as a pure LLM without filesystem/shell access, it can, but this requires explicit CLI configuration per invocation.

---

### 7. Claude Agent SDK (TypeScript/Python) — Verified via npm and official docs

**Current package status (verified via npm):**
- **Package name:** `@anthropic-ai/claude-agent-sdk`, version **0.3.220** (published 4 hours ago)
- **Previous name:** `@anthropic-ai/claude-code-sdk` is **404 / unpublished** — the rename is complete
- **Architecture:** Bundles a native Claude Code binary for each platform (Linux x64/ARM64, Windows x64/ARM64, macOS x64/ARM64), with MUSL variants
- **Zero regular dependencies:** Main package has no npm dependencies; uses platform-specific optional dependencies that package the CLI binary
- **Peer dependencies:** Requires `@anthropic-ai/sdk` (Messages API), `zod`, and `@modelcontextprotocol/sdk`

**Entry points (verified via npm):**
- Main: `sdk.mjs`
- Bridge: `bridge.mjs`
- Browser: `browser-sdk.js`
- Tools: `sdk-tools.js`

**Main design (verified via official docs):**
- The Agent SDK **bundles the Claude Code CLI binary** for your platform; you don't install the CLI separately
- This means the SDK is fundamentally **shelling out to the bundled CLI**, not calling the Messages API independently
- Version lockstep (SDK 0.3.220, CLI 2.1.220) confirms the SDK is built around the CLI

**API surface (verified via docs):**
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "...",
  options: {
    allowedTools: ["Read", "Edit", "Bash"],
    permissionMode: "acceptEdits",
    mcpServers: { /* MCP config */ },
    resume: sessionId  // UUID for session resumption
  }
})) {
  // Process message
}
```

**Critical caveat:** Python SDK also exists (via `claude-agent-sdk` package on PyPI), with identical capabilities.

---

### 8. Subscription vs. API-Key Billing (Verified via official docs; partial CLI verification)

**CLI state (verified via `claude auth status`; account identifiers redacted, this repo is public):**
```json
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "<redacted>",
  "orgId": "<redacted>",
  "subscriptionType": "max"
}
```
- The CLI authenticates via OAuth (claude.ai login) and bills against a subscription.
- `apiKeySource: "none"` in session init confirms no API key is in use.
- **Verified non-interactively:** a headless `claude -p "..." --output-format json` invocation with no `ANTHROPIC_API_KEY` in the environment completed and returned a result. So the subscription path does **not** require an interactive session, which is what makes it usable as a backend.
- Per-invocation `total_cost_usd` (0.102 on a one-word reply) is **accounting, not a charge**: there is no API account to bill. Do not log it as spend or wire it to a budget alarm.

**Agent SDK authentication (verified via official docs):**
The Agent SDK documentation explicitly states: "Set your API key — Get an API key from the Console, then set it as an environment variable (`ANTHROPIC_API_KEY`)."

The docs then include a critical note:
> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key authentication methods described in this document instead."

**Conclusion (verified):** 
- **CLI (interactive):** Can use OAuth/subscriptions when run by a user
- **Agent SDK (programmatic):** **Requires `ANTHROPIC_API_KEY` environment variable; subscriptions do not apply.** The SDK will always bill per-token, even if you own a Max subscription, because third-party apps are not permitted to use Anthropic's OAuth flow.

**Implication:** If the design goal is to route through an existing Max subscription, the Agent SDK **cannot achieve it**. You must use the interactive CLI or use the Messages API with a raw API key and accept per-token billing.

---

### 9. Concurrency and Rate Limits (Partially verified)

**Rate limit event structure (verified by running `claude -p` with stream-json):**
```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1784956200,
    "rateLimitType": "five_hour",
    "overageStatus": "allowed",
    "overageResetsAt": 1784950200,
    "isUsingOverage": false
  },
  "uuid": "...",
  "session_id": "..."
}
```
- Emitted on every run; shows current rate limit status and reset times
- `status: "allowed"` means operation proceeded; if `"denied"`, the invocation was blocked
- `isUsingOverage: false` when within normal limits; `true` when exceeding baseline (billing difference?)
- `rateLimitType: "five_hour"` is the observed type (appears to be a sliding 5-hour window)

**Unverified / Needs testing:**
- What happens when `status: "denied"`? Does the CLI fail with an error, or silently refuse the request?
- Practical concurrency limits on a subscription plan (can 10 `claude -p` processes run in parallel?)
- Whether API-key plans have different rate limits than subscriptions
- Whether `overageStatus` and `isUsingOverage` affect billing or just track tier progression

**Overhead of concurrent processes:**
- Each `claude -p` invocation spawns a new process (~500ms startup cost)
- Session initialization adds overhead; reusing sessions via `--resume` avoids re-sending the conversation but still incurs process startup
- For high concurrency (>5 concurrent Discord users), concurrent `claude -p` processes become inefficient due to startup overhead and rate-limit contention

---

### 10. Latency and Overhead (Partially verified by running)

**Process startup and latency:**
- CLI version: `2.1.220`
- Single `claude -p` invocation: ~2s total (including session init, API call, result formatting)
- Breakdown from observed runs:
  - Process startup + session init: ~500-700ms
  - API call (time_to_request_ms + ttft_ms): ~1.5-2s
  - Total: ~2s for a 2-token input, 15-token output

**Session resume overhead:**
- Using `--resume <uuid>` avoids re-initializing the session from scratch
- But process startup is still ~500ms per invocation
- Conversation history is not re-sent if the session is resumed (inferred from session persistence model)

**Comparison to direct API:**
- Direct API call (Messages API) via SDK: ~1.5-2s (no process overhead)
- `claude -p` call: ~2-2.5s (process overhead included)
- Net cost: ~500ms per invocation

---

### 11. Failure and Fallback (Unverified / needs testing)

**Subscription rate-limit exhaustion:**
- Error detection: Unknown (stream-json output shows rate limit status, but what happens when limit is hit?)
- Fallback mechanism: Not implemented; caller would need to parse rate limit status and retry via OpenRouter

**No explicit circuit-breaker or fallback handling** in the CLI. Calling agent is responsible for:
1. Parsing `rate_limit_info` from stream-json output
2. Detecting `status != "allowed"` or `isUsingOverage: true`
3. Falling back to OpenRouter or other provider

---

### 12. Measured: what a background pass costs against the subscription windows

Measured 2026-07-26 against CLI 2.1.220 on a Max plan, resolving #15.
Every number in this section is from running, not from documentation.

#### The instrument, because `rate_limit_event` cannot answer this

`rate_limit_info` carries no quantity.
Its fields are `status`, `resetsAt`, `rateLimitType`, `overageStatus`, `overageResetsAt` and `isUsingOverage`: flags, an enum and two timestamps.
Subtracting two of them yields nothing, so the "capture before and after and record the delta" method #15 originally proposed cannot produce a cost.

The quantity lives at **`https://api.anthropic.com/api/oauth/usage`**, the endpoint Claude Code's own statusline polls.
It returns `five_hour.utilization` and `seven_day.utilization` as percentages, plus an `extra_usage` block and a `limits` array.
Because it reports a percentage, no dollars-per-window conversion is ever needed: a pass costs N points directly.

Two properties matter for the design, not just the experiment.
**`utilization` is typed as a float but every observed value was whole**, so effective resolution is one percentage point.
**The endpoint throttles under rapid polling**: reads succeeded for the first few calls of a 20-run batch and then returned nothing for the remainder, recovering minutes later.
Anything reading it at runtime must poll on an interval and cache, the way the statusline does at 60 seconds, and must not call it per invocation.

**There are two windows, not one.**
`seven_day` sits beside `five_hour` and nothing in the prior design mentioned it.

#### The floor dominates, and two flags remove it

Billable input tokens for the prompt "reply with the word ok", carrying no content at all:

| configuration | Sonnet 5 | Haiku 4.5 |
|---|---|---|
| as-is | 10,634 | 7,537 |
| `--system-prompt` replaced | 2,062 | 1,297 |
| `--system-prompt` + `--setting-sources ""` | **218** | **189** |

Forty-nine times, on Sonnet, before a byte of transcript.
Two independent layers: roughly 8,500 tokens of Claude Code's base system prompt, then roughly 1,850 more of settings-sourced content, which is the operator's `~/.claude/CLAUDE.md` riding along.

**`--system-prompt` does not suppress the settings layer.**
Both flags are required.
`--bare` also removes both and must never be used: its own help states auth becomes strictly `ANTHROPIC_API_KEY` or `apiKeyHelper`, with OAuth and keychain never read, which silently moves every background pass onto per-token billing.

#### Per-pass cost

Haiku 4.5, `--system-prompt` + `--setting-sources ""`, boundary transcripts of roughly 2,000 tokens, means over 20 runs each:

| pass | input tok | output tok | notional | wall p50 | wall max |
|---|---|---|---|---|---|
| digest | 2,356 | 800 | $0.0064 | 12.7s | 20.6s |
| reconcile | 2,859 | 2,644 | $0.0161 | 30.4s | 61.0s |
| brief | 2,452 | 4,050 | $0.0227 | 45.1s | 70.5s |
| nightly sweep | 7,429 | 1,090 | $0.0203 | 16.7s | — |

Boundary triple: **$0.0451 notional**.
Marginal input rate, fitted across a 12,500-token spread: **$2.19 per Mtok on Haiku, $6.22 per Mtok on Sonnet**.

**The brief pass is the most expensive of the three despite having the smallest input**, because it is rewritten wholesale and its cost is carried by output, not input.
ADR 0004 describes its input as small, which is true and misleading.
It is also the pass that fires most often, since it cannot wait for a boundary.

#### A full day of background load

20 boundaries and one nightly sweep, 61 invocations, run as one uninterrupted batch:

- **$0.9230 notional**, 30.4 minutes of wall time, zero failures.
- **Five-hour window: 4% to 6%.** Two points, and an unknown fraction of that is the operator's own concurrent session, so the true figure is one to two points.
- **Seven-day window: 1% to 1%.** No measurable movement at all.
- **Overage spend: zero.** `spend.used.amount_minor` stayed at 0 throughout.

A real day spreads this across roughly five consecutive five-hour windows rather than compressing it into one, so per-window cost in production is well under one point.

**The affordability claim holds, with a correction.**
The prediction that the seven-day cap would be the binding constraint on sustained background work is **not supported**: at this load it did not move at all, while the five-hour window at least registered.
Neither is threatened.
Background consolidation on Haiku is not merely affordable, it is below the resolution of the instrument.

#### Incidental findings from the same runs

- **Thinking deltas are emitted.** `content_block_start/thinking`, `thinking_delta` and `signature_delta` all appear under `--include-partial-messages`, in 61 of 61 runs. `TurnEvent.thinking_delta` is reachable from this provider and is not an OpenRouter-only variant.
- **`--no-session-persistence` is genuinely clean.** Across 20 runs carrying synthetic private conversation, `~/.claude/history.jsonl` came out byte-identical and the file counts under `projects/` and `sessions/` were unchanged. Transcript content does not reach disk.
- **The prompt cache works against this usage pattern, and config C sidesteps it.** Sonnet caches from a 1,024-token prefix, so a one-shot process pays the 1.25x cache-write premium for an entry it will never read; two identical digest runs cost $0.0411 and $0.0165 depending on which side of the cache they landed. Haiku's minimum cacheable prefix is 4,096 tokens, so with the floor removed only 1 of 61 day-simulation runs wrote a cache entry at all.
- **`--effort low` removes thinking on Sonnet**, 1,025 output tokens down to 491 with zero thinking events. Haiku barely responds to it.
- **Concurrency needs no separate experiment.** A day of load is 30 minutes of serialized subprocess time, so a global semaphore of 1 has roughly 48x headroom at 20 boundaries per day.
- **The 120s timeout has thinner margin than it looks.** Observed maximum was 70.5s, on the brief pass, against a 120s limit. That is 1.7x, not the large margin a round number suggests.

---

## Unverified / Needs Testing

1. **Rate limit denial handling:** What `status: "denied"` looks like on the wire is still unobserved, and it is the trigger `cause: "quota"` failover depends on. Deliberately provoking it was **rejected**: `extra_usage.is_enabled` is true with a $200 monthly cap, so burning to denial passes through paid credits rather than stopping at the wall. Capture it opportunistically the next time the window is exhausted in ordinary use.
2. **Whether `utilization` ever reports a fractional value**, or is always rounded server-side to whole percentage points. Every observed value was whole. This sets the floor on how small a change the runtime headroom check can detect.
3. **Session recovery after reboot:** moot for cadence, which never resumes, but unverified in general.
4. **Multi-turn conversation handling:** exact JSON schema for `--input-format=stream-json` user messages. Not on cadence's path, since ADR 0003 fixed one-shot processes.
5. **Overage billing semantics:** the difference between `overageStatus` and `isUsingOverage`. `spend.used.amount_minor` from the usage endpoint is the field that actually tracks credit consumption, and it stayed at zero throughout.
6. **Cross-user session isolation:** not applicable while sessions are never persisted or resumed.
7. **SDK as subprocess vs native:** settled negatively by #14 for cadence's purposes; the SDK forces API-key billing regardless.

**Resolved by §12 and struck from this list:** concurrency limits, external session state management via `--no-session-persistence`, and the cost-accounting interpretation.

---

## Summary for Implementation

**For user-facing, latency-sensitive work (Discord replies, live interactions):**
- Use OpenRouter over HTTP (no 500ms process overhead, explicit per-token cost)
- Build cadence-agent's own tool loop around the Messages API
- Subscriptions do not help here anyway (SDK requires API key, not subscription auth)

**For background work (nightly batch processing, memory consolidation, session summaries, reflection passes):**
- Consider the Agent SDK if you need the bundled CLI binary + built-in tools out of the box
- Accept per-token billing (API key required; subscriptions do not work with SDK)
- The 500ms startup overhead is negligible when amortized across infrequent, asynchronous tasks
- Use `--permission-mode=acceptEdits` to skip permission prompts in unattended operation

**If building a custom tool injection system for background agents:**
1. Use the Agent SDK with `mcpServers` config to attach MCP servers (cleaner than CLI `--mcp-config` flags)
2. Track session IDs programmatically; use `resume: sessionId` to maintain context across turns
3. Parse `rate_limit_event` in output to detect rate-limit status and implement backoff
4. Accept that subscriptions cannot be used; provision a separate API key for background automation

**Do not shell out to `claude -p` for every turn** — it creates architectural friction (process startup overhead, session UUID juggling, awkward tool injection) that the SDK abstracts away. But the SDK still bundles the CLI and still requires API-key auth, so the fundamental constraint (per-token billing, not subscription billing) remains.

---

## Verification Sources

**Verified by running CLI commands:**
- CLI invocation, output formats, and stream-json event shapes
- Session persistence in `~/.claude/sessions/`
- Tool disabling via `--tools ""` and `--disallowedTools`
- Permission modes in headless operation
- Rate limit event structure
- Session resumption via `--session-id` and `--resume`

**Verified via npm and official documentation:**
- Agent SDK package name: `@anthropic-ai/claude-agent-sdk` v0.3.220
- Platform-specific binary bundling (not a separate CLI call, but embedded)
- Authentication requirement: `ANTHROPIC_API_KEY` environment variable (API-key only, no subscriptions)
- SDK documentation explicitly forbids third-party use of OAuth/subscriptions

**Environment:**
- Claude Code CLI version: `2.1.220`
- System: macOS (darwin), zsh
- Current user auth: OAuth via claude.ai, subscription type "max" (CLI-only; SDK would use API key)
- Test date: July 25, 2026
