# OpenRouter as an HTTP model provider

Research date: 2026-07-25.
All prices are USD per million tokens unless stated otherwise.
Every claim is marked **[verified]** with a source URL, or **[uncertain]**.
Live-API claims were checked against `https://openrouter.ai/api/v1/models` on 2026-07-25 (345 models returned).

## Verdict

**Recommended client: the `openai` npm SDK pointed at `https://openrouter.ai/api/v1`, wrapped in our own narrow provider interface.**
Not the Vercel AI SDK, not `@openrouter/sdk`, not raw `fetch`.

The reasoning in one paragraph.
OpenRouter's entire product is "the OpenAI Chat Completions wire format, normalised across 345 models", so the best-maintained implementation of that wire format is the right transport, and `openai` gives us SSE parsing, retries, timeouts and `AbortSignal` for free.
Everything valuable that OpenRouter adds on top (`reasoning`, `reasoning_details`, `provider`, `models`, `cache_control`, `session_id`, `usage.cost`) is a non-OpenAI field, and every wrapper layer turns those into a second dialect (`extraBody`, `providerOptions`, `providerMetadata`) that costs types and gains nothing.
We will be reaching for raw fields on most turns, not rarely.

**Do not implement Vercel's `LanguageModelV3` as our provider interface.**
It is shaped for HTTP models and is large (files, sources, provider-executed tools, tool-approval requests, logprobs, `supportedUrls`).
A `claude -p` subprocess can honour maybe a third of it, so the subprocess provider would become an adapter full of ignored options and thrown "unsupported" errors.
Define a smaller interface that both sides can honour honestly.

### Minimal provider interface

Modelled on Pi's `packages/ai`, which is the most credible existing answer to this shape (see §10).

```ts
interface ModelProvider {
  readonly id: string;                       // "openrouter" | "claude-cli"
  stream(req: TurnRequest, opts?: TurnOptions): AsyncIterable<TurnEvent>;
}

type TurnRequest = {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDef[];                          // JSON Schema; provider maps to its own shape
};

type TurnOptions = {
  signal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  reasoning?: "off" | "low" | "medium" | "high" | "max";
  cache?: "none" | "short" | "long";          // provider maps to cache_control / ttl / nothing
  sessionId?: string;                         // OpenRouter cache stickiness; claude -p session resume
  raw?: Record<string, unknown>;              // one escape hatch, merged into the provider payload
};

type TurnEvent =
  | { type: "start";             partial: AssistantMessage }
  | { type: "text_delta";        index: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_delta";    index: number; delta: string; partial: AssistantMessage }
  | { type: "tool_call_delta";   index: number; delta: string; partial: AssistantMessage }
  | { type: "tool_call";         index: number; call: ToolCall; partial: AssistantMessage }
  | { type: "done";  reason: "stop" | "length" | "tool_use"; message: AssistantMessage }
  | { type: "error"; reason: "error" | "aborted"; message: AssistantMessage };
```

Five rules make this hold for both an HTTP provider and a subprocess provider.

1. **Nothing in the interface names HTTP.** No headers, no status codes, no base URL. Transport concerns live inside each provider's constructor.
2. **Errors terminate the stream as an `error` event, never as a throw after the iterator is obtained.** Pi states this as an explicit contract: "Once invoked, request/model/runtime failures should be encoded in the returned stream, not thrown." Both an HTTP 502 mid-stream and a subprocess exiting 1 mid-stream are the same shape to the caller, so the Discord layer has exactly one failure path. **[verified]** [pi types.ts L297-320](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts)
3. **Every event carries the accumulating `partial` message.** Consumers render from `partial` rather than maintaining their own reducer. This matters for a Discord bot doing throttled message edits.
4. **Content blocks carry opaque provider signatures.** `ThinkingContent` needs a `thinkingSignature?: string` and `ToolCall` needs a `signature?: string`. This is the single field most abstractions omit, and omitting it makes Anthropic extended thinking plus tool calling silently break on the second turn, because the reasoning blocks you send back must byte-match what the model produced. Pi carries exactly these (`thinkingSignature`, `thoughtSignature`, plus a `redacted` flag whose encrypted payload is stashed in the signature). **[verified]** [pi types.ts L329-358](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts)
5. **Options a provider cannot honour are ignored, not rejected.** Pi's `StreamOptions` says this per field ("Providers that do not support this option ignore it"). A subprocess provider ignoring `temperature` must not be an error.

`Usage` must separate cache reads from cache writes and carry money, not just tokens:

```ts
type Usage = {
  input: number; output: number;             // input excludes cacheRead and cacheWrite
  cacheRead: number; cacheWrite: number;
  reasoning?: number;                         // subset of output
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};
```

### The two biggest gotchas

1. **`supported_parameters` is a routing filter, not a capability oracle.** Of 345 models, 274 declare `tools` but only **4** declare `parallel_tool_calls`. Nearly every model that in fact emits parallel tool calls does not advertise the parameter. Treat the field as "will this endpoint reject my request body", never as "can this model do X". See §2.
2. **Explicit prompt caching is effectively Anthropic-only, and it is the difference between a viable and a non-viable agent economically.** Anthropic and Alibaba Qwen need per-block `cache_control` breakpoints that you place yourself; everything else is automatic. Combined with OpenRouter's provider sticky routing (which by default keys off a hash of your first system message and first non-system message), a naive agent that mutates its system prompt each turn will both miss the cache and get re-routed to a cold provider. Pin with `session_id`. See §5.

---

## API surface

### 1. Endpoint, auth headers, OpenAI compatibility

**Endpoint** **[verified]** [api_reference/overview](https://openrouter.ai/docs/api_reference/overview.md)

```
POST https://openrouter.ai/api/v1/chat/completions
```

**Headers** **[verified]** [api_reference/overview](https://openrouter.ai/docs/api_reference/overview.md), [guides/community/openai-sdk](https://openrouter.ai/docs/guides/community/openai-sdk.md)

| Header | Required | Purpose |
| --- | --- | --- |
| `Authorization: Bearer <key>` | yes | auth |
| `Content-Type: application/json` | yes | |
| `HTTP-Referer` | no | identifies your app for openrouter.ai rankings |
| `X-OpenRouter-Title` (also accepts `X-Title`) | no | app display name for rankings |
| `X-OpenRouter-Categories` | no | marketplace categories |
| `x-session-id` | no | cache/provider stickiness, see §5 |

`HTTP-Referer` and `X-Title` still exist and are still purely attribution.
The canonical name is now `X-OpenRouter-Title` with `X-Title` kept as an accepted alias.
Nothing functional depends on them, so set them once and forget them.

**How OpenAI-compatible is it really.**
The docs state OpenRouter "normalizes the schema across models and providers to comply with the OpenAI Chat API". **[verified]**
In practice the compatibility is genuine for the request body and good-but-extended for the response.
Pi, a production client, constructs a plain `new OpenAI({ apiKey, baseURL: model.baseUrl })` for OpenRouter and casts to `any` for the extras. **[verified]** [pi openai-completions.ts L663-668](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts)

Non-OpenAI request fields OpenRouter adds: `models?: string[]`, `route?: 'fallback'`, `provider?: ProviderPreferences`, `plugins?: Plugin[]`, `reasoning?: {...}`, `session_id?: string`, `transforms`, `prediction`, `top_k`, `min_p`, `top_a`, `repetition_penalty`, `debug?: { echo_upstream_body?: boolean }`. **[verified]** [api_reference/overview](https://openrouter.ai/docs/api_reference/overview.md)

Non-OpenAI response fields: every choice carries `native_finish_reason` alongside `finish_reason`, and `usage` carries `cost`, `cost_details`, `is_byok`. **[verified]** same source.

Beyond chat completions, OpenRouter now has dedicated `POST /api/v1/embeddings`, `/images`, `/videos`, `/audio/speech`, `/audio/transcriptions`, `/rerank`, and an OpenAI-compatible **Responses API** that the TypeScript SDK still exposes as `Beta.Responses`. **[verified]** [llms.txt](https://openrouter.ai/docs/llms.txt), [api_reference/responses/overview](https://openrouter.ai/docs/api_reference/responses/overview.md)
For an agent, stay on chat completions: it is the stable surface, and the Responses API is still labelled beta.

### 2. Tool calling and how inconsistent it is

**Request shape** **[verified]** [guides/features/tool-calling](https://openrouter.ai/docs/guides/features/tool-calling.md), [api_reference/overview](https://openrouter.ai/docs/api_reference/overview.md)

```json
{
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "...",
      "parameters": { "type": "object", "properties": { }, "required": [] }
    }
  }],
  "tool_choice": "auto",
  "parallel_tool_calls": true
}
```

`tool_choice` accepts `'none' | 'auto' | { type: 'function', function: { name } }`. **[verified]**
The documented type union does **not** include `'required'`.
**[uncertain]** whether `tool_choice: "required"` is accepted and passed through; the type definition in the API reference omits it, so do not rely on it. Force a specific tool by name instead, which is documented.

`parallel_tool_calls` defaults to `true` for most models; set `false` for one-at-a-time. **[verified]**

**Response shape** **[verified]**

```json
{ "role": "assistant", "content": null,
  "tool_calls": [{ "id": "call_abc123", "type": "function",
                   "function": { "name": "get_weather", "arguments": "{\"city\":\"Oslo\"}" } }] }
```

`arguments` is a JSON **string**, always. Tool results go back as `{ "role": "tool", "tool_call_id": "call_abc123", "content": "..." }`.

**Strict schemas.**
`strict` is documented for `response_format.json_schema` (§4). **[verified]**
For *tool* definitions the tool-calling docs do not mention `strict` at all. **[verified]** (absence)
Pi does send `strict` on the function object and gates it per provider, explicitly because "some reject unknown fields", disabling it for Moonshot, Together, Cloudflare AI Gateway and NVIDIA. **[verified]** [pi openai-completions.ts L1301-1309, L1454](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts)
Read that as: strict tool schemas work on the major families and are a per-endpoint gamble elsewhere.

**How inconsistent is it, concretely.**
This is where OpenRouter is at its weakest, and the live data shows it. From `/api/v1/models` on 2026-07-25:

| Declared parameter | Models declaring it (of 345) |
| --- | --- |
| `tools` | 274 |
| `tool_choice` | 274 |
| `structured_outputs` | 268 |
| `reasoning_effort` | 86 |
| `parallel_tool_calls` | **4** |

The four are `z-ai/glm-5.2`, `moonshotai/kimi-k2.7-code`, `moonshotai/kimi-k2.6`, `minimax/minimax-m2.5`. **[verified, live API]**
Claude, GPT-5.x and Gemini all emit parallel tool calls in practice yet none of them declare the parameter.
So `supported_parameters` answers "will this endpoint reject this body key", not "can this model do this".
Pi never sends `parallel_tool_calls` at all. **[verified]** (grep of pi openai-completions.ts finds no occurrence)

**Programmatic discovery.** Two levels, both public and unauthenticated. **[verified, live API]**

```
GET https://openrouter.ai/api/v1/models
GET https://openrouter.ai/api/v1/models?supported_parameters=tools
GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints
```

The full `supported_parameters` vocabulary observed live across all 345 models:

```
frequency_penalty, include_reasoning, logit_bias, logprobs, max_completion_tokens,
max_tokens, min_p, parallel_tool_calls, prediction, presence_penalty, reasoning,
reasoning_effort, repetition_penalty, response_format, seed, stop, structured_outputs,
temperature, tool_choice, tools, top_a, top_k, top_logprobs, top_p, verbosity,
web_search_options
```

Support is **per endpoint, not per model**: the same model served by three providers can differ. **[verified]** [guides/features/structured-outputs](https://openrouter.ai/docs/guides/features/structured-outputs.md)
The `/endpoints` call returns per-provider `supported_parameters` and pricing, which is the only honest source. Verified live, for example `openai/text-embedding-3-small` returns separate OpenAI and Azure endpoints with different parameter lists.
To make routing respect this rather than checking it yourself, set `provider: { require_parameters: true }`. **[verified]**

Useful and non-obvious: OpenRouter measures a **Tool Call Error Rate** per provider, surfaces it on each model's performance tab, and feeds it into "Auto Exacto" provider ordering for tool-calling requests. **[verified]** [guides/features/tool-calling](https://openrouter.ai/docs/guides/features/tool-calling.md)

Model-family guidance, stated as inference rather than fact.
**[uncertain]** OpenRouter publishes no per-family table for parallel calls, strict schemas or forced choice. Based on the `supported_parameters` data plus Pi's per-provider gating, the reliable set for all three is the first-party families routed to their own upstreams: `anthropic/*`, `openai/*`, `google/*` and `x-ai/*`. Open-weight models on aggregator providers (Together, Fireworks, DeepInfra, NVIDIA, Cloudflare) are where strict mode and forced choice degrade. If this matters, resolve it empirically per endpoint rather than trusting any table.

### 3. Streaming

**SSE format** **[verified]** [api_reference/streaming](https://openrouter.ai/docs/api_reference/streaming.md)

```
data: {"id":"gen-...","choices":[{"delta":{"content":"Hel"}}]}
: OPENROUTER PROCESSING
data: {"id":"gen-...","choices":[{"delta":{"content":"lo"}}]}
data: [DONE]
```

Lines beginning with `:` are SSE comments used as keep-alives and must be skipped before JSON parsing.
The stream terminates with `data: [DONE]`.

**Tool calls in deltas.**
The docs say only that tool data "arrives incrementally through delta objects" and that you accumulate until `finish_reason === "tool_calls"`. **[verified]**
The exact field shape is not spelled out in the docs, but it is unambiguous from Pi's production parser: **[verified]** [pi openai-completions.ts L376-407, L517-545](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts)

```jsonc
{ "choices": [{ "delta": { "tool_calls": [{
    "index": 0,                                  // may be absent
    "id": "call_abc123",                         // may arrive on a later chunk than index
    "function": { "name": "get_weather", "arguments": "{\"ci" }
}]}}]}
```

The accumulation gotcha, straight out of that code: **key your accumulator on `index` when present and fall back to `id`, and be ready for `id` and `name` to arrive on a chunk after the first**. Pi keeps two maps (`toolCallBlocksByIndex`, `toolCallBlocksById`) and back-fills, precisely because some upstreams omit `index`.
There is also a `delta.tool_calls[].custom` variant carrying `{ name, input }` for OpenAI custom/grammar tools rather than `function.arguments`. **[verified]** same source. We can ignore it unless we adopt grammar-constrained tools.

**Reasoning tokens in the stream.** **[verified]** [guides/best-practices/reasoning-tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md)

Request side, a normalised `reasoning` object:

```jsonc
{ "reasoning": {
    "effort": "minimal|low|medium|high|xhigh|max|none",   // OpenAI, Grok
    "max_tokens": 8192,                                   // Anthropic, Gemini, Qwen (min 1024, max 128000 Anthropic)
    "enabled": true,                                      // shorthand for medium
    "exclude": true,                                      // reason internally, omit from response
    "context": "auto|all_turns|current_turn",             // OpenAI GPT-5.6+
    "mode": "standard|pro"                                // OpenAI GPT-5.6+
} }
```

Response side, two channels: `message.reasoning` (plain string) and `message.reasoning_details` (structured array). In streaming these appear as `choices[].delta.reasoning` and `choices[].delta.reasoning_details`. **[verified]**

`reasoning_details` entries have `{ id, format, index, type }` where `type` is one of `reasoning.summary`, `reasoning.encrypted` (with `data`, may render as `[REDACTED]`), or `reasoning.text` (with an optional `signature`). `format` is a provider tag such as `anthropic-claude-v1` or `openai-responses-v1`. **[verified]**

The critical multi-turn rule: to keep reasoning across tool calls you send back `message.reasoning_details` verbatim, and "the entire sequence of consecutive reasoning blocks must match the outputs generated by the model during the original request". **[verified]**
This is why the provider interface needs opaque signature passthrough.

One more real-world wrinkle: not every upstream uses `delta.reasoning`. Pi probes `reasoning_content`, then `reasoning`, then `reasoning_text`, taking the first non-empty, because some endpoints emit two of them with identical content. **[verified]** [pi openai-completions.ts L484-515](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts)

**Usage in stream.** The final chunk carries `usage`. `stream_options: { include_usage: true }` is **deprecated and has no effect**; usage is now always included. **[verified]** [cookbook/administration/usage-accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting.md)
Some providers (Moonshot named) put usage on `choices[0].usage` instead of `chunk.usage`; read both. **[verified]** [pi openai-completions.ts L446-457](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts)

**Cancellation.** `AbortController` works, but only for streaming requests with supporting providers. Unsupported providers keep generating and you are billed for the full response. OpenAI, Anthropic, Fireworks and Together support it; Groq, Google, Mistral and Replicate do not. **[verified]** [api_reference/streaming](https://openrouter.ai/docs/api_reference/streaming.md)
For a Discord bot where users cancel, this is a real cost line, not a footnote.

**Mid-stream failure.** Once any token has been sent, errors arrive as an SSE event and the HTTP status stays **200**: **[verified]** [api_reference/errors-and-debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging.md)

```json
{ "error": { "code": 502, "message": "...", "metadata": {} },
  "choices": [{ "finish_reason": "error" }] }
```

The stream ends after that event. A client that only checks HTTP status will report success on a failed generation. Pi additionally treats "stream ended without `finish_reason`" as an error, which is worth copying. **[verified]** [pi openai-completions.ts L577-579](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts)

### 4. Structured output

**[verified]** [guides/features/structured-outputs](https://openrouter.ai/docs/guides/features/structured-outputs.md)

```json
{ "response_format": { "type": "json_schema",
    "json_schema": { "name": "weather", "strict": true, "schema": { } } } }
```

`{ "type": "json_object" }` is also accepted. **[verified]** [api_reference/overview](https://openrouter.ai/docs/api_reference/overview.md)

268 of 345 models declare `structured_outputs`. **[verified, live API]**
Enforcement is not uniform: the docs say some providers guarantee conformance, some translate your schema into their own structured-output format, and some "treat it as a strong hint". **[verified]**
So validate the parsed output yourself regardless. Named as compatible: OpenAI, Google Gemini, Anthropic, Fireworks. **[verified]**

Failure modes: an unsupported endpoint returns an error, and an invalid JSON Schema causes a model error. Pair `response_format` with `provider: { require_parameters: true }` so routing skips endpoints that lack it. **[verified]**

Streaming works and emits progressively-valid partial JSON. **[verified]**

### 5. Prompt caching

This is the section that matters most for an agent re-sending a system prompt every turn.
**[verified]** [guides/best-practices/prompt-caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching.md) for everything below unless noted.

**Mechanism per provider**

| Provider | Automatic | Needs `cache_control` |
| --- | --- | --- |
| Anthropic Claude | yes (top-level mode) | yes, for per-block control |
| Alibaba Qwen | no | yes |
| Google Gemini | partial (implicit on 2.5) | yes, for explicit breakpoints |
| OpenAI | yes | optional explicit mode |
| DeepSeek, Grok, Moonshot, Z.AI | yes | no |
| Groq | yes (Kimi K2 models only) | no |

**Anthropic explicit breakpoints**, on a text content part:

```json
{ "messages": [{ "role": "system", "content": [
    { "type": "text", "text": "You are a historian studying the Roman Empire:" },
    { "type": "text", "text": "HUGE TEXT BODY", "cache_control": { "type": "ephemeral", "ttl": "1h" } }
]}]}
```

There is also a top-level `"cache_control": { "type": "ephemeral" }` sibling of `messages` that turns on Anthropic's automatic mode.

**OpenAI explicit caching** is a different dialect entirely:

```json
{ "prompt_cache_options": { "mode": "explicit", "ttl": "30m" },
  "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "REUSABLE PREFIX", "prompt_cache_breakpoint": { "mode": "explicit" } },
    { "type": "text", "text": "TASK-SPECIFIC SUFFIX" }
]}]}
```

**Pricing multipliers**

| Provider | Cache write | Cache read |
| --- | --- | --- |
| Anthropic | 1.25x (5-min TTL), 2.0x (1-hour TTL) | 0.1x |
| OpenAI (GPT-5.6+) | 1.25x | 0.25x to 0.50x, model-dependent |
| Alibaba Qwen | 1.25x | 0.1x |
| DeepSeek | 1.0x | 0.1x |
| Google Gemini 2.5 | input + 5-min storage | 0.25x |
| Grok, Moonshot | no cost | 0.25x |
| Groq | no cost | 0.5x |
| Z.AI | no cost | ~0.2x, model-dependent |

A 0.1x read on Anthropic is the whole game for a long-lived agent.
The live `/models` data corroborates the ratios directly: `anthropic/claude-sonnet-5` lists `prompt` 2.00, `input_cache_read` 0.20, `input_cache_write` 2.50. **[verified, live API]**

**Minimum cacheable prompt (Anthropic)**

- 4,096 tokens: Claude Opus 4.5 to 4.8, Haiku 4.5
- 2,048 tokens: Haiku 3.5
- 1,024 tokens: Sonnet 4 to 4.6, Opus 4 to 4.1
- Gemini 2.5 Flash 1,024; Gemini 2.5 Pro 4,096

**Sticky routing, and the trap.**
When caching is on, OpenRouter pins a conversation to the provider that holds the warm cache. By default it derives the routing key by **hashing the first system/developer message and the first non-system message**. **[verified]**
An agent that stamps a timestamp or channel id into its system prompt therefore gets a fresh routing key and a cold cache every turn.
Override with `session_id` as a top-level body field or the `x-session-id` header, max 256 characters. This pins immediately, before any cache hit exists. **[verified]**

**Inspecting cache effect.**
`usage.prompt_tokens_details.cached_tokens` (reads) and `usage.prompt_tokens_details.cache_write_tokens` (writes). **[verified]**
Note the accounting rule Pi follows: `prompt_tokens` **includes** both, so real uncached input is `prompt_tokens - cached_tokens - cache_write_tokens`, and you must not subtract writes from `cached_tokens`. **[verified]** [pi openai-completions.ts L1315-1351](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts)
`cache_discount` is also documented as a savings figure on the generation record. **[verified]**

**Where to put breakpoints.** Pi's production strategy, worth copying verbatim:

1. the system/instruction message,
2. the **last tool definition** in the `tools` array,
3. the last conversation message.

**[verified]** [pi openai-completions.ts L886-929](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts)
Caching the tools array is the one people forget, and for an agent with a dozen tool schemas it is a large constant prefix.

**And the heuristic that tells you how narrow this really is:** Pi applies `cache_control` **only when the OpenRouter model id starts with `anthropic/`**.

```ts
const cacheControlFormat = provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined;
```

**[verified]** [pi openai-completions.ts L1426](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts)
Everything else they leave to automatic caching. That is a strong signal about where the effort pays off.

### 6. Provider routing controls

**[verified]** [guides/routing/provider-selection](https://openrouter.ai/docs/guides/routing/provider-selection.md), cross-checked against Pi's typed `OpenRouterRouting` interface which documents the same field set. [pi types.ts L650-723](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts)

```jsonc
{ "provider": {
    "order": ["anthropic", "google-vertex"],   // try in sequence
    "only":  ["anthropic"],                     // exclusive allow-list
    "ignore": ["together"],                     // skip these
    "allow_fallbacks": true,                    // default true
    "require_parameters": false,                // default false; route only where all params supported
    "data_collection": "allow" | "deny",
    "zdr": true,                                // Zero Data Retention endpoints only
    "enforce_distillable_text": false,
    "quantizations": ["fp16", "bf16", "fp8", "int8", "int4"],
    "sort": "price" | "throughput" | "latency" | { "by": "price", "partition": "model" | "none" },
    "max_price": { "prompt": 3, "completion": 15, "image": 0, "request": 0 },
    "preferred_min_throughput": { "p50": 40 },
    "preferred_max_latency": { "p90": 2.5 }
} }
```

Provider slugs are base names (`anthropic`, `openai`, `google-vertex`) with variant suffixes (`deepinfra/turbo`, `google-vertex/us-east5`). Model-id shortcuts `:nitro` (throughput) and `:floor` (price) do the common cases inline. **[verified]**

`zdr: true` and `data_collection: "deny"` combine with account-wide preferences as an **OR**, so a per-request setting cannot loosen an account restriction. **[verified]**

**Model fallbacks** **[verified]** [guides/routing/model-fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks.md)

```json
{ "models": ["anthropic/claude-sonnet-5", "openai/gpt-5.6-terra"], "route": "fallback" }
```

Tried in order on context-length errors, moderation flags, rate limits and downtime.
Billing uses the model that actually served, and **the response `model` field tells you which**. Log that field, never the requested id, or your cost attribution silently lies whenever a fallback fires.
`sort: { partition: "none" }` sorts globally across the `models` array instead of per model. **[verified]**

To pin a single upstream: `provider: { only: ["anthropic"], allow_fallbacks: false }`. To avoid one: `provider: { ignore: [...] }`.

### 7. Errors, limits, retry policy

**Error shape** **[verified]** [api_reference/errors-and-debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging.md)

```ts
type ErrorResponse = { error: { code: number; message: string; metadata?: Record<string, unknown> } };
```

`error.code` equals the HTTP status.

| Status | Meaning | Retry? |
| --- | --- | --- |
| 400 | invalid or missing params, CORS | no, fix the request |
| 401 | invalid credentials, expired OAuth, disabled key | no |
| 402 | insufficient credits | no, alert |
| 403 | insufficient permissions, guardrail block, moderation flag | no |
| 404 | not found | no |
| 408 | request timeout | yes |
| 429 | rate limited | yes, honour `Retry-After` |
| 502 | model down or invalid upstream response | yes, or fall back to another model |
| 503 | no provider meets routing requirements | yes, but loosen `provider` constraints first |
| 504 | provider did not respond in time | yes |

`error.metadata` carries `error_type`, described as a **canonical typed error code stable across providers**, plus `provider_code` for the raw upstream code (omitted on 500s). Branch retry logic on `error_type` rather than parsing messages. **[verified]**
Moderation blocks put `reasons`, `flagged_input` (truncated to 100 chars), `provider_name` and `model_slug` in metadata. **[verified]**

**Rate limits and credits** **[verified]** [api_reference/limits](https://openrouter.ai/docs/api_reference/limits.md)

`GET /api/v1/key` returns `limit`, `limit_remaining`, `limit_reset`, `usage`, `usage_daily`, `usage_weekly`, `usage_monthly`, `is_free_tier`, `byok_usage`, `include_byok_in_limit`.

`:free` models: 20 requests/minute; 50/day under $10 lifetime spend, 1,000/day at $10+.
A negative balance returns **402 for everything, including free models**.
Beyond the documented caps, DDoS protection blocks traffic that "dramatically exceeds reasonable usage".
Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` when applicable.

**A robust policy for this agent**

1. Retry 408/429/502/504 with exponential backoff and jitter, capped at 3 attempts, honouring `Retry-After`. Delegate to the `openai` SDK's `maxRetries` for the pre-stream case.
2. **Never blind-retry a stream that already emitted tokens.** Either resume from accumulated content or discard the turn. This is the case wrappers get wrong.
3. Cap the server-requested backoff. Pi fails fast when the requested delay exceeds a ceiling (default 60s) so higher-level logic can surface it to the user rather than hanging. **[verified]** [pi types.ts L115-193](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) For a Discord bot, a 90-second silent stall is worse than an error message.
4. Use `models: [primary, fallback]` for model-level resilience and reserve client retries for transport faults. Cheaper and faster than round-tripping.
5. Treat 402 and 403 as terminal and alert, do not retry.
6. Treat empty content as a soft failure, not success. Docs attribute it to cold starts (seconds to minutes), and note **upstream providers may charge for prompt processing even with no output**. **[verified]**
7. Enforce a max-iteration cap on the agent loop; the docs recommend it explicitly. **[verified]** [guides/features/tool-calling](https://openrouter.ai/docs/guides/features/tool-calling.md)

### 8. Cost visibility

**[verified]** [cookbook/administration/usage-accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting.md)

`usage: { include: true }` and `stream_options: { include_usage: true }` are **deprecated no-ops**. Full usage is always returned, in the final SSE chunk when streaming.

```ts
type ResponseUsage = {
  prompt_tokens: number; completion_tokens: number; total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number; cache_write_tokens?: number;
                            audio_tokens?: number; video_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number; image_tokens?: number };
  cost?: number;                     // credits charged to your account
  is_byok?: boolean;
  cost_details?: { upstream_inference_cost?: number;
                   upstream_inference_prompt_cost: number;
                   upstream_inference_completions_cost: number };
  server_tool_use?: { web_search_requests?: number };
};
```

**[verified]** [api_reference/overview](https://openrouter.ai/docs/api_reference/overview.md)

For per-turn dollar logging, read `usage.cost` from the last chunk. That is the authoritative charge and needs no second request.
`GET /api/v1/generation?id=<response id>` exists for historical audit; `upstream_inference_cost` there is only populated for BYOK requests.

Three things to log per turn so the numbers stay honest:

- `usage.cost` (not a price-table estimate),
- `response.model` (the model that actually served, post-fallback),
- `cached_tokens` and `cache_write_tokens` (so a caching regression shows up as a cost spike you can explain).

---

## Client abstraction

### 9. Which client

Four real options, with current versions verified against the npm registry on 2026-07-25.

| Option | Version | Notes |
| --- | --- | --- |
| `openai` pointed at OpenRouter | current | what Pi does |
| `ai` + `@openrouter/ai-sdk-provider` | `ai@7.0.37` (2026-07-23), provider `3.0.0` (2026-07-06) | provider peer-deps `ai@^7.0.0`, `zod ^3.25.76 \|\| ^4.1.8`; Node 22+; ESM-only |
| `@openrouter/sdk` | `1.1.6` (2026-07-25) | first-party, ESM-only, only dep is `zod`; docs still say "currently in beta" |
| `@openrouter/agent` | `0.8.0` (2026-07-22) | first-party agent toolkit; depends `@openrouter/sdk ^0.13.7` |

**[verified, npm registry]** for all versions and dates.

**Recommendation: `openai` SDK as transport, behind our own interface.**

Why, against the criteria asked:

**Tool-calling ergonomics.** The AI SDK wins on paper: Zod schemas, typed `execute`, `stopWhen`. But we are building the agent loop anyway, because a Discord bot needs its own interleaving of tool execution with message edits, approval gates and per-guild budgets. Once you own the loop, the SDK's loop is dead weight and its tool abstraction is a thin Zod-to-JSON-Schema call we can make ourselves in ten lines. Meanwhile the raw shape is trivial and stable, and the delta-accumulation gotcha from §3 is something we must handle explicitly regardless of layer.

**Streaming.** `openai` gives correct SSE parsing, `[DONE]` handling, comment-line skipping and `AbortSignal` plumbing. The AI SDK gives a nicer stream-part union, which is exactly the thing we are defining ourselves for the subprocess provider's sake, so buying it twice is a cost not a benefit.

**Provider-specific passthrough.** This decides it. Every OpenRouter differentiator is a non-OpenAI field, and in the AI SDK they all go through `extraBody` or `providerOptions.openrouter`, which are `Record<string, unknown>`. So the fields we touch most often (`reasoning`, `provider`, `models`, `cache_control`, `session_id`) are the fields with the least type safety in that path. With the `openai` SDK we cast the params object once at the boundary and keep our own strict types for the whole body, which is strictly better typing for our actual usage. Note the AI SDK provider's passthrough nests further for per-upstream options: `extraBody.provider.options['<provider-slug>']`. **[verified]** [guides/community/vercel-ai-sdk](https://openrouter.ai/docs/guides/community/vercel-ai-sdk.md)

**Type safety.** `openai`'s types cover the compatible core exactly and we own the extension types. The AI SDK's types are excellent for its own normalised model and lossy at precisely the boundary we care about; `usage.cost` arrives via `providerMetadata`, not the typed usage object.

**When it fights you.** Any normalising layer fights hardest on reasoning-block round-tripping (§3), because correctness there depends on byte-preserving opaque blobs the abstraction has no reason to model. `openai` + our own types never has to fight, because there is nothing between us and the body.

**Why not the first-party SDKs.** `@openrouter/sdk` is Speakeasy-generated (the `funcs/chatSend.js` tree-shaking pattern and `chatRequest`-nested arguments give it away), the docs still label it beta, and `chat.send({ chatRequest: { ... } })` adds a wrapper level for nothing. `@openrouter/agent` is more interesting (real `tool()` helper, `stopWhen` with `maxCost(amount)` and `stepCountIs(n)`, lifecycle hooks, `fromClaudeMessages`) but it pins `@openrouter/sdk ^0.13.7` while that package is at `1.1.6`, which is a major-version skew inside a first-party pair, and its docs describe converting to "OpenResponses input format", meaning it targets the **beta** Responses API rather than chat completions. **[verified]** [client-sdks/agent-migration](https://openrouter.ai/docs/client-sdks/agent-migration.md), [agent-sdk/call-model/api-reference](https://openrouter.ai/docs/agent-sdk/call-model/api-reference.md), npm registry.
Worth revisiting in a few months; not worth building on today.

**Why not raw `fetch`.** No upside. We would reimplement SSE framing, retries and timeouts, and get the `: OPENROUTER PROCESSING` and mid-stream-200-error cases wrong at least once.

One caveat to state plainly: if we later decide `claude -p` should be an opaque tool rather than a peer provider, the calculus flips and the AI SDK becomes the better choice, because the only remaining consumer would be HTTP models and its loop would then be worth having.

### 10. Unifying an HTTP provider and a subprocess provider

**Direct finding, and it corrects the premise: Pi's `packages/ai` does not unify a subprocess provider.**
Every one of its 36 providers is HTTP. `Model` requires `baseUrl: string`, and each `KnownApi` (`openai-completions`, `anthropic-messages`, `google-generative-ai`, `bedrock-converse-stream`, `mistral-conversations`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `google-vertex`, `pi-messages`) is a wire protocol. Providers like `github-copilot`, `opencode` and `kimi-coding` look like local tools but are HTTP endpoints with OAuth. **[verified]** [pi packages/ai/src listing](https://github.com/earendil-works/pi/tree/main/packages/ai/src), [pi types.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts)

So there is no existing credible abstraction that spans both. What Pi does give us is a **transport-agnostic interface that would extend to a subprocess without changes**, which is the more useful result. Its core is a single function type:

```ts
type StreamFunction<TApi, TOptions extends StreamOptions> =
  (model: Model<TApi>, context: Context, options?: TOptions) => AssistantMessageEventStream;

interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[] }
```

**[verified]** [pi types.ts L297-320, L477-489](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts)

Three properties make it portable, and all three are things the AI SDK's interface does not give you:

- The contract is stated as "failures encoded in the returned stream, not thrown", terminating in `done` or `error` with `stopReason` `"error" | "aborted"` and an `errorMessage`. A subprocess crash and an HTTP 502 become the same event.
- `StreamOptions` is small and every field is documented as ignorable by providers that do not support it.
- Events carry the accumulating `partial: AssistantMessage`, so the consumer needs no protocol-specific reducer.

**Contrast with `LanguageModelV3`.** **[verified]** [vercel/ai language-model-v3.ts](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v3/language-model-v3.ts), [call-options](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v3/language-model-v3-call-options.ts), [stream-part](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v3/language-model-v3-stream-part.ts)

It requires `specificationVersion: 'v3'`, `provider`, `modelId`, `supportedUrls: Record<string, RegExp[]>`, plus `doGenerate` and `doStream`. `LanguageModelV3CallOptions` includes `topK`, `topP`, `seed`, `presencePenalty`, `frequencyPenalty`, `stopSequences`, `responseFormat`, `includeRawChunks`. The stream-part union includes `tool-approval-request`, provider-executed tools, `file`, `source`, `raw` and a `stream-start` warnings array.
That is a well-designed interface for HTTP models and a poor fit for `claude -p`, which owns its own sampling, executes its own tools, and cannot honour `seed`, `topK`, `logprobs` or `supportedUrls`. Implementing it for a subprocess means a large class of silently-ignored options plus `doGenerate` faked from `doStream`.

Its stream-part vocabulary is worth borrowing though. The three-phase `text-start`/`text-delta`/`text-end` and `tool-input-start`/`tool-input-delta`/`tool-input-end` split with stable ids is cleaner than a bare index, and both Pi and the AI SDK converged on it independently, which is decent evidence it is right.

**The one place a unified interface genuinely leaks.**
`claude -p` may execute its own tools. So `TurnEvent` cannot assume that a `tool_call` event means "caller must now execute this and send a result back". Handle it explicitly rather than papering over it: give the provider a declared capability, `toolExecution: "caller" | "provider"`, and let the subprocess provider emit `tool_call` plus its own result as observability events while the loop treats the turn as complete. Do not try to make one code path serve both; that is where these abstractions rot.

Secondary leak: model identity. `Model.baseUrl` being required is exactly the HTTP assumption that keeps Pi's interface from spanning transports. Keep model identity to `{ providerId, modelId }` and let each provider resolve the rest internally.

### 11. Sensible 2026 defaults on OpenRouter

Prices from the live `/api/v1/models` response on **2026-07-25**, in USD per million tokens. **[verified, live API]**
**These change often. Read them from the API at build or boot time rather than hardcoding them.**

**Main reasoning and tool-calling loop**

| Model id | In | Out | Cache read | Cache write | Context |
| --- | --- | --- | --- | --- | --- |
| `anthropic/claude-sonnet-5` | 2.00 | 10.00 | 0.20 | 2.50 | 1,000,000 |
| `openai/gpt-5.6-terra` | 2.50 | 15.00 | 0.25 | 3.125 | 1,050,000 |
| `google/gemini-3.6-flash` | 1.50 | 7.50 | 0.15 | 0.083 | 1,048,576 |
| `anthropic/claude-opus-5` | 5.00 | 25.00 | 0.50 | 6.25 | 1,000,000 |

Recommend **`anthropic/claude-sonnet-5`**. It has `tools`, `tool_choice`, `structured_outputs` and `reasoning_effort` in `supported_parameters`, a 1M context, and the 0.1x cache-read ratio that makes a re-sent system prompt nearly free. Escalate to `anthropic/claude-opus-5` for hard turns. Use `models: ["anthropic/claude-sonnet-5", "openai/gpt-5.6-terra"]` as the fallback pair, since a cross-vendor fallback survives a single-vendor outage.

**Cheap fast summariser**

| Model id | In | Out | Cache read | Context |
| --- | --- | --- | --- | --- |
| `google/gemini-3.5-flash-lite` | 0.30 | 2.50 | 0.03 | 1,048,576 |
| `openai/gpt-5.4-nano` | 0.20 | 1.25 | 0.02 | 400,000 |
| `qwen/qwen3.5-flash-02-23` | 0.065 | 0.26 | n/a | 1,000,000 |
| `openai/gpt-oss-120b` | 0.037 | 0.17 | n/a | 131,072 |

Recommend **`google/gemini-3.5-flash-lite`**: 1M context matters for summarising long Discord history, and it declares `tools`, `structured_outputs` and `reasoning_effort`. Drop to `qwen/qwen3.5-flash-02-23` if summarisation volume becomes a real cost line; it is roughly 5x cheaper on input with the same context, though it does not declare `reasoning_effort`.

**Embeddings**

Embedding models are **not** in `/api/v1/models`; that endpoint returns chat models only, and all 345 have text-ish output modalities. They are reachable via `POST /api/v1/embeddings` and listed at [openrouter.ai/collections/embedding-models](https://openrouter.ai/collections/embedding-models). Ids and input prices verified individually through `/api/v1/models/{id}/endpoints`. **[verified, live API]**

| Model id | In | Notes |
| --- | --- | --- |
| `qwen/qwen3-embedding-8b` | 0.01 | cheapest credible; Nebius and DeepInfra at 0.01, SiliconFlow at 0.04 |
| `baai/bge-m3` | 0.01 | 1024 dims |
| `openai/text-embedding-3-small` | 0.02 | OpenAI and Azure endpoints, both 0.02 |
| `google/gemini-embedding-2` | 0.20 | flexible 128 to 3,072 dims |
| `openai/text-embedding-3-large` | 0.13 | |

Recommend **`openai/text-embedding-3-small`** at 0.02. Two independent endpoints for availability, and it is the most widely-benchmarked default. `qwen/qwen3-embedding-8b` at 0.01 is the choice if volume dominates.

Request shape: `{ "model", "input", "encoding_format"?, "provider"? }` where `input` is a string, array of strings, or multimodal content objects; response is `{ "data": [{ "embedding": number[], "index": number }] }`. **[verified]** [api_reference/embeddings](https://openrouter.ai/docs/api_reference/embeddings.md)

Two cautions. `dimensions` is **[uncertain]**: it is not listed in the documented request fields even though the underlying OpenAI and Gemini models support it. And the `supported_parameters` returned for embedding endpoints is meaningless (it lists `temperature`, `top_p`, `stop`), clearly a shared-schema artifact, so do not read capability from it.

**Model alias forms.** OpenRouter exposes floating aliases prefixed with `~`, for example `~anthropic/claude-opus-latest`, `~anthropic/claude-sonnet-latest`, `~openai/gpt-latest`, `~google/gemini-flash-latest`. **[verified, live API]**
Do not use them in production. A silent model change breaks reasoning-block round-tripping, prompt caching and cost forecasts at once. Pin exact ids and upgrade deliberately.

---

## Unverified

Claims below are inferences, gaps, or things the docs do not settle. Treat as open questions.

1. **`tool_choice: "required"`.** The documented `ToolChoice` union is `'none' | 'auto' | { type: 'function', function: { name } }`. Whether `"required"` is accepted is unconfirmed. Test before relying on it; forcing a named function is the documented path.
2. **`strict` on tool function definitions.** Documented for `response_format.json_schema` but not for tools. Pi sends it and gates it per provider, which implies it works on major families and is risky elsewhere. Not confirmed from OpenRouter docs.
3. **Per-family reliability of parallel tool calls, strict schemas and forced tool choice.** OpenRouter publishes no such table, and `supported_parameters` demonstrably does not answer it (4 of 345 declare `parallel_tool_calls`). My grouping in §2 (first-party upstreams reliable, aggregator-hosted open-weight models degrade) is inference from Pi's per-provider gating, not documented fact. Resolve empirically per endpoint. OpenRouter's published Tool Call Error Rate per provider is the best available signal.
4. **Whether OpenRouter exposes an Anthropic-Messages-compatible endpoint.** The model-fallbacks page references a `fallbacks` parameter that "cannot be combined with `models`" "when using the Anthropic Messages API", and there are docs pages for Claude Code and the Anthropic Agent SDK against OpenRouter, so such a surface very likely exists. I did not find and read its API reference. Relevant to the `claude -p` side, so worth confirming.
5. **Streaming tool-call delta shape.** The exact field names (`delta.tool_calls[].index`, `.id`, `.function.arguments`) come from Pi's production parser and from OpenAI-format equivalence, not from an OpenRouter doc that spells them out. High confidence, but not first-party-documented.
6. **`embeddings` request `dimensions` field.** Not in the documented field list. Unconfirmed whether it is accepted and passed through.
7. **Exact `usage.cost` semantics under BYOK.** `cost` is "total charge to your account" and `cost_details.upstream_inference_cost` is BYOK-only. How `cost` behaves for a partial mid-stream failure (charged or zero) is not documented. Matters for per-turn accounting; measure it.
8. **Cancellation provider coverage.** The supported/unsupported provider lists are documented but will drift. Do not hardcode; assume cancellation may not stop billing.
9. **`@openrouter/agent` production readiness.** Its dependency on `@openrouter/sdk ^0.13.7` against a `1.1.6` latest may be a stale manifest rather than a real constraint; I did not verify the installed tree. Its reliance on the beta Responses API is the more substantive concern.
10. **Whether `parallel_tool_calls` is silently dropped or rejected** on models that do not declare it. Pi's choice never to send it suggests caution is warranted, but the failure mode is unconfirmed.

## Sources

- [OpenRouter API reference overview](https://openrouter.ai/docs/api_reference/overview.md)
- [Tool and function calling](https://openrouter.ai/docs/guides/features/tool-calling.md)
- [Streaming](https://openrouter.ai/docs/api_reference/streaming.md)
- [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs.md)
- [Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching.md)
- [Reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md)
- [Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection.md)
- [Model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks.md)
- [Errors and debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging.md)
- [Limits](https://openrouter.ai/docs/api_reference/limits.md)
- [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting.md)
- [Embeddings](https://openrouter.ai/docs/api_reference/embeddings.md)
- [Using the OpenAI SDK](https://openrouter.ai/docs/guides/community/openai-sdk.md)
- [Vercel AI SDK integration](https://openrouter.ai/docs/guides/community/vercel-ai-sdk.md)
- [TypeScript SDK overview](https://openrouter.ai/docs/client-sdks/typescript/overview.md)
- [Migrating to @openrouter/agent](https://openrouter.ai/docs/client-sdks/agent-migration.md)
- [callModel API reference](https://openrouter.ai/docs/agent-sdk/call-model/api-reference.md)
- [docs llms.txt index](https://openrouter.ai/docs/llms.txt)
- Live API: `GET https://openrouter.ai/api/v1/models` and `/api/v1/models/{id}/endpoints`, 2026-07-25
- [Pi `packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts)
- [Pi `packages/ai/src/api/openai-completions.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts)
- [Vercel AI SDK `LanguageModelV3`](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v3/language-model-v3.ts)
- npm registry: `@openrouter/sdk`, `@openrouter/agent`, `@openrouter/ai-sdk-provider`, `ai`
