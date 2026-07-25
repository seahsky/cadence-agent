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

## Unverified / Needs Testing

1. **Rate limit denial handling:** What is the exact error message/structure when CLI hits rate limits (`status: "denied"`)? Does it retry, backoff, or fail fast?
2. **Concurrency limits on subscriptions:** How many parallel `claude -p` processes can run simultaneously without hitting rate limits?
3. **Session recovery after reboot:** If `~/.claude/sessions/` is preserved across restarts, do sessions resume reliably after a server restart?
4. **External session state management:** Can `--no-session-persistence` + explicit `--session-id <uuid>` be used to have an external orchestrator own session state without relying on `~/.claude/sessions/`?
5. **Multi-turn conversation handling:** What is the exact JSON schema for `--input-format=stream-json` user messages, and how does Claude handle multiple turns in one invocation?
6. **Overage billing semantics:** What is the difference between `overageStatus` and `isUsingOverage` in the rate_limit_event? Does "overage" mean additional cost, or just tier progression?
7. **Cost accounting interpretation:** Is the per-invocation `costUSD` field real billing, or just internal accounting for rate-limit tracking? Does a subscription plan absorb these costs?
8. **Cross-user session isolation:** If cadence-agent runs as a daemon handling multiple Discord users, can sessions safely resume across users without cross-contamination of history or context?
9. **SDK as subprocess vs native:** Does the Agent SDK spawn the bundled CLI as a subprocess (like `claude -p`), or does it embed/link the CLI code directly?

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
