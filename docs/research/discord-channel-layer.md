# Discord as a channel for cadence-agent

Research date: 2026-07-25.
All version numbers and limits below were fetched live from primary sources on this date.
Discord's developer docs moved host: `discord.com/developers/docs/*` now 301-redirects to `docs.discord.com/developers/*`.
Anything I could not confirm against a primary source is in the [Unverified](#unverified) section rather than stated inline.

---

## Verdict

**Library: `discord.js` v14 (currently 14.27.0, published 2026-07-15).**
It is still the right choice.
It is actively released (five releases since March 2026), it is the only option with a large corpus of working examples, and it is built on the same `@discordjs/ws` + `@discordjs/rest` packages you would otherwise assemble by hand.
Require Node 22 LTS or newer even though v14 only demands Node 18, because the unreleased v15 already requires Node 24.17.0 and you do not want the runtime to be the thing blocking that upgrade.
The OOP surface of discord.js conflicts with a functional codebase, but that conflict is contained: the channel adapter is exactly the "connector to an external system" case, so let discord.js classes live inside `channels/discord/` and never leak a `Message` object past the adapter boundary.
`@discordjs/core` is the escape hatch if the client cache becomes a memory problem; see [Library choice](#1-library-choice).

**Interaction model: DM-first free-text, with slash commands only for control verbs.**
This is not a style preference, it is driven by the intent rules.
Message content in DMs with the app is **exempt** from the `MESSAGE_CONTENT` privileged intent, as are messages that @mention the app.
So a DM-first agent reads full free text with only non-privileged intents, forever, at any scale.
Reserve slash commands for things that need discoverability and structure (`/new`, `/model`, `/forget`), not for the conversation itself, because interactions carry a hard 3-second acknowledgement deadline and a 15-minute total token lifetime.

**Session boundary: the channel id is the session key; the agent owns the session lifecycle itself.**
Use `channel.id` as the session identity in all contexts, because it is the one identifier that exists in DMs, guild channels, and threads alike.
Then layer your own lifecycle on top of it: idle timeout plus an explicit reset command.
You must do this because **threads do not exist in DMs** — a thread's `parent_id` is documented as "the id of the `GUILD_TEXT` or `GUILD_ANNOUNCEMENT` channel the thread was created in" — so in the primary interaction mode Discord hands you no session boundary at all.
In guild channels, auto-thread on mention and let the thread be the session; that path gets a real boundary for free, and `channel.id` is still the key because the thread has its own id.

### The three constraints that most shape the design

1. **The `MESSAGE_CONTENT` intent splits the product in two, and DMs are on the free side.**
   DM content and @mention content are exempt.
   Everything else in a guild channel arrives with `content`, `embeds`, `attachments`, `components`, and `poll` **empty strings/arrays** — not missing, not an error, just blank.
   Design for the exempt path and the intent becomes optional forever; design for ambient guild-channel reading and you have taken on an annual re-application obligation above 10,000 reachable users.

2. **2000 characters, and no streaming primitive.**
   `content` is capped at 2000 characters on both create and edit.
   There is no partial-message or streaming API; "streaming" means editing one message repeatedly.
   Per-route edit limits are deliberately unpublished and discord.js *queues* rather than throws by default, so over-fast edits do not 429 — they silently accumulate latency. Every reply has to pass through a chunker plus a coalescing edit throttle.

3. **No threads in DMs, and 1000 IDENTIFYs per 24 hours.**
   The first kills session-per-thread as a primary model.
   The second is a live foot-gun in development: exceeding 1000 gateway identifies in 24 hours terminates all sessions **and resets your bot token**, so a crash-loop on a hot-reloading dev process can lock you out.

---

## Getting messages in

### 1. Library choice

| Package | Latest | Published | Node |
|---|---|---|---|
| `discord.js` | 14.27.0 | 2026-07-15 | `>=18` (stated in the v14 README: "Node.js 18 or newer is required.") |
| `discord.js` (`dev` tag, v15) | `15.0.0-dev.1784593104-...` | unreleased | `main` README: "Node.js 24.17.0 or newer is required." |
| `@discordjs/core` | 2.6.0 | 2026-07-15 | `>=20` |
| `seyfert` | 5.0.0 | 2026-07-11 | not declared |
| `@sapphire/framework` | 5.5.0 | 2025-12-24 | `>=v18` |
| `oceanic.js` | 1.14.0 | 2026-03-06 | `>=18.13.0` |

Sources: npm registry metadata for each package; [discord.js v14.27.0 README](https://github.com/discordjs/discord.js/blob/14.27.0/packages/discord.js/README.md); [discord.js main README](https://github.com/discordjs/discord.js/blob/main/packages/discord.js/README.md); [discord.js releases](https://github.com/discordjs/discord.js/releases).

**v15 is not released.** It exists only under the `dev` dist-tag; there is no non-prerelease v15 in the GitHub releases list. Build on v14 and pin it.

Recommendation, in order:

- **`discord.js` v14 — use this.** Actively maintained, richest documentation, and it already ships the Components V2 builders you may want later (`packages/builders/src/index.ts` at tag 14.27.0 exports `Container`, `TextDisplay`, `Section`, `Separator`, `MediaGallery`, `Thumbnail`).
- **`@discordjs/core` 2.6.0 — the principled alternative.** Same maintainers, same `@discordjs/rest` and `@discordjs/ws` underneath, but no structure classes and no cache: you receive raw gateway dispatch payloads typed by `discord-api-types` and pass plain data around. That is a better fit for a pure-function codebase and it sidesteps the partials problem in [DMs](#3-dms) entirely, because there is no cache to miss. The cost is that you implement everything convenience-shaped yourself. Choose this only if client memory or the OOP surface becomes a demonstrated problem, not preemptively.
- **`@sapphire/framework` — do not use.** It is a *command* framework (command/listener/precondition pieces) layered on discord.js. cadence-agent's primary input is unstructured free text, so the abstraction it sells is the one you do not need, and it is the least recently released of the options.
- **`seyfert` — no.** Actively maintained and modern, but a much smaller ecosystem for a foundational dependency, and you gain nothing that matters here.
- **Raw gateway — no.** Reconnect, resume, heartbeat jitter, identify concurrency, and per-bucket REST rate limiting are all solved in `@discordjs/ws` and `@discordjs/rest`. Reimplementing them is pure downside.

### 2. Gateway intents

Intents and bit values, from [Gateway Intents](https://docs.discord.com/developers/events/gateway#gateway-intents):

| Intent | Bit | Privileged | Relevant to cadence-agent |
|---|---|---|---|
| `GUILDS` | `1 << 0` | no | yes — guild/channel/thread lifecycle events |
| `GUILD_MESSAGES` | `1 << 9` | no | only if reading guild channels |
| `GUILD_MESSAGE_TYPING` | `1 << 11` | no | optional |
| `DIRECT_MESSAGES` | `1 << 12` | **no** | **yes — the primary path** |
| `DIRECT_MESSAGE_REACTIONS` | `1 << 13` | no | optional (reaction-as-signal) |
| `DIRECT_MESSAGE_TYPING` | `1 << 14` | no | optional |
| `MESSAGE_CONTENT` | `1 << 15` | **yes** | only for ambient guild reading |
| `GUILD_MEMBERS` | `1 << 1` | yes | no |
| `GUILD_PRESENCES` | `1 << 8` | yes | no |

`DIRECT_MESSAGES` is **not** privileged. That is the single most important fact in this document.

**What `MESSAGE_CONTENT` actually gates**, verbatim from the docs:

> `MESSAGE_CONTENT (1 << 15)` is a unique privileged intent that isn't directly associated with any Gateway events. Instead, access to `MESSAGE_CONTENT` permits your app to receive message content data across the APIs.

> Any fields affected by the message content intent are noted in the relevant documentation. For example, the `content`, `embeds`, `attachments`, `components`, and `poll` fields in message objects all contain message content and therefore require the intent.

> Apps **without** the intent will receive empty values in fields that contain user-inputted content with a few exceptions:
> - Content in messages that an app sends
> - Content in DMs with the app
> - Content in which the app is [mentioned](https://docs.discord.com/developers/reference#message-formatting-formats)
> - Content of the message a [message context menu command](https://docs.discord.com/developers/interactions/application-commands#message-commands) is used on

Note that `attachments` is in that list. Without the intent, and outside the exemptions, you do not get the user's images either — the vision path and the text path stand or fall together.

The companion guide [You Might Not Need a Privileged Intent](https://docs.discord.com/developers/gateway/you-might-not-need-a-privileged-intent) states the exemptions slightly differently and adds a fourth:

> - "Messages your app sends"
> - "Direct Messages sent to your app"
> - "Messages that @mention your app"
> - "Replies to your app's messages" (via Discord's reply feature with ping enabled)

The reply exemption is conditional on ping being enabled. A user who replies with the ping toggled off produces an empty `content`. Handle that: if `content` is empty and `attachments` is empty on a message you would otherwise act on, that is the signature of a content-intent miss, and it should produce a one-time explanatory reply rather than an empty model call.

**Approval process, as of the June 2026 change.** The old "100 servers" threshold is gone. From [Getting Started with Privileged Intent Review](https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review):

- Threshold is now unique users reachable across all installed servers: "If that number exceeds 10,000, your app needs to apply for Privileged Intent access."
- "This means a bot in 50 large servers could hit the threshold, while a bot in 200 small servers might not."
- Below the threshold: "Apps with fewer than 10,000 users can access privileged intents by enabling them in the Developer Portal." A toggle, no review.
- On crossing it you get notified and have "90 days from the date of the notification to apply."
- While under review: "Your app will continue to function with the intents you are requesting access to. Your app may also continue to grow and join new servers during this time."
- "Apps that already have Privileged Intent access granted from a prior review must reapply each year."
- Verification and privileged-intent review are now separate processes.

**What breaks without it.** Nothing, if you stay inside the exemptions. Outside them, `content` arrives as `""`. There is no error and no event suppression, which is why this is such a common silent failure.

**Failure mode if you request it without enabling it:** the gateway connection is closed with close code `4014`.

**The path that avoids it entirely:** DM-first plus mention-triggered, exactly as recommended. Slash commands, message context menu commands, message components, and modals are all listed as intent-free alternatives, and the guide says these primitives were "built specifically so that most bots don't need access to the Message Content intent."

### 3. DMs

Yes, a bot receives DMs. Requirements:

1. **`DIRECT_MESSAGES` intent** (`1 << 12`), which is not privileged.
2. **No `MESSAGE_CONTENT`** needed — DM content is exempt.
3. **`Partials.Channel` in discord.js.** This is the classic gotcha. DM channels can be uncached, and per the [discord.js partials guide](https://discordjs.guide/popular-topics/partials), "Channel (only DM channels can be uncached, server channels will always be available)". If you miss the partial "the event does not get emitted" — your `messageCreate` handler simply never fires for a DM after a restart, with no error anywhere.

   ```js
   const { Client, GatewayIntentBits, Partials } = require('discord.js');
   const client = new Client({
     intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
     partials: [Partials.Channel],
   });
   ```

4. **A shared guild, in practice.** Discord's client-side privacy model governs who may open a DM with whom; a bot is not exempt from it. For a private single-operator bot this is a non-issue — the owner invites the bot to their own private guild during setup, which establishes the shared-guild relationship, and thereafter the DM works. I could not confirm the precise rule from the developer docs; see [Unverified](#unverified).

5. **Do not initiate DMs in bulk.** From [Create DM](https://docs.discord.com/developers/resources/user#create-dm) (`POST /users/@me/channels`, body `{ recipient_id }`): "You should not use this endpoint to DM everyone in a server about something. DMs should generally be initiated by a user action. If you open a significant amount of DMs too quickly, your bot may be rate limited or blocked from opening new ones." Calling it when a DM already exists returns the existing channel, so it is safe and idempotent for the single-operator case.

Other DM gotchas worth encoding in the adapter:

- A DM channel has type `1` (`DM`) and **no `guild_id`**. Any code that assumes `message.guild` is non-null will throw. This is the most common source of DM crashes.
- There are no permissions in a DM. Permission checks must be skipped, not evaluated, when `guild_id` is absent.
- Threads cannot be created in a DM. See [Structure and identity](#11-grouping-primitives-and-the-session-boundary).
- `GROUP_DM` is type `3`. A bot cannot be added to a group DM by a normal user flow; treat type `3` as unsupported and ignore it.

### 4. Message vs slash command vs app-DM

| | Free-text `messageCreate` | Slash command | Message context menu |
|---|---|---|---|
| Natural back-and-forth | yes | no — every turn is a command invocation | no |
| Needs `MESSAGE_CONTENT` | no in DM / on mention; yes otherwise | never | never |
| Response deadline | none | **3s to ack**, 15min token lifetime | same as slash |
| Discoverable | no | yes, with autocomplete and typed args | yes |
| Works in DM | yes | yes | yes |

The interaction deadlines are the deciding factor, quoted from [Receiving and Responding](https://docs.discord.com/developers/interactions/receiving-and-responding):

- You "must send an initial response within 3 seconds of receiving the event". Miss it and the token is invalidated.
- "Interaction tokens are valid for **15 minutes**, meaning you can respond to an interaction within that amount of time."
- `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` (type `5`) — "ACK an interaction and edit a response later, the user sees a loading state".

So a slash command wrapping a model call must defer immediately and then edit, and the whole turn must finish inside 15 minutes. An agent that runs tools for twenty minutes cannot live inside an interaction token at all.

**Recommendation.** Free-text `messageCreate` in DMs is the conversation. It has no deadline, no token expiry, and needs no privileged intent. Register a small set of slash commands for control verbs only — they are the only discoverable surface Discord gives you, and users will look for them. Ack-and-defer inside every one.

On "app-DM": [install contexts](https://docs.discord.com/developers/resources/application#application-object-application-integration-types) are `GUILD_INSTALL = 0` and `USER_INSTALL = 1`. A user install lets the app's *commands* travel with the user anywhere, including DMs with other people. It is not a substitute for a bot user receiving DMs, and it does not grant free-text reading. For a private single-operator agent, `GUILD_INSTALL` plus a bot user is the correct and simpler shape. Keep `USER_INSTALL` in mind only if the agent later needs to be summoned into servers it is not a member of.

---

## Getting replies out

### 5. The 2000-character limit

**Confirmed 2000, for both create and edit.** From [`message.mdx`](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx), the Create Message body and the Edit Message body both document `content` as "Message contents (up to 2000 characters)".

Embed limits, verbatim from the same file:

| Field | Limit |
|---|---|
| `title` | 256 characters |
| `description` | 4096 characters |
| `field.name` | 256 characters |
| `field.value` | 1024 characters |
| `footer.text` | 2048 characters |
| `author.name` | 256 characters |
| fields per embed | 25 |
| embeds per message | 10 |

> Additionally, the combined sum of characters in all `title`, `description`, `field.name`, `field.value`, `footer.text`, and `author.name` fields across all embeds attached to a message must not exceed 6000 characters. Violating any of these constraints will result in a `Bad Request` response.

Also: "All of the following limits are measured inclusively. Leading and trailing whitespace characters are not included (they are trimmed automatically)."

**On 4000.** The developer docs do not contain a 4000-character message limit. 4000 appears in the docs only as the max for a modal text input (`min_length` / `max_length` "min 0, max 4000") and as an embed `description` cap of 4096. The widely-cited 4000-character message limit is a Nitro *user account* feature; bots do not have Nitro. **Treat 2000 as the hard cap for anything cadence-agent sends.** See [Unverified](#unverified).

**Strategy, in priority order:**

1. **Chunk plain `content` at 2000.** This should be the default and it should be the only path most replies take. Chunking rules that matter in practice:
   - Split on paragraph boundaries first, then sentence, then hard-cut. Never split mid-word.
   - Track fenced code blocks across the split. If a chunk ends inside a ``` fence, close it and re-open it with the same language on the next chunk, or the rest of the reply renders as prose in Discord and the following chunk's formatting corrupts.
   - Budget below 2000, not at it. Reserve headroom for the fence re-open and any continuation marker.
   - Send chunks sequentially and await each one, so ordering is guaranteed; discord.js queues per-bucket but you should not rely on queue ordering for user-visible sequence.
2. **File attachment for anything long.** Past roughly three chunks, a `.md` or `.txt` attachment is better UX than a wall of messages, and it dodges the whole chunking problem. Attachments have their own size limit; see [9](#9-attachments-and-images).
3. **Embeds — use sparingly.** They buy 4096 characters in one `description` and give visual structure, but they render differently, they are not selectable/copyable the same way, and the 6000-character cross-embed budget is easy to blow. Good for structured status output, bad for conversational prose.
4. **Threads for organisation, not for length.** See [13](#13-auto-threading).

I did not verify what specific commercial agents do; the above is engineering recommendation, not an observed-practice claim.

### 6. Streaming a reply

There is no streaming primitive. Editing one message repeatedly is the technique, and it is still the technique in 2026.

**The actual rate limits are not published.** From [Rate Limits](https://docs.discord.com/developers/topics/rate-limits): "Rate limits should not be hard coded into your app. Instead, your app should parse response headers to prevent hitting the limit." Discord publishes the global limit and the bucket mechanism, and deliberately does not publish per-route numbers. The commonly-repeated "5 edits per 5 seconds per channel" is not in the documentation — see [Unverified](#unverified).

**The failure mode is latency, not errors.** This is the important operational point and it comes from the discord.js source, not from Discord. `DefaultRestOptions` in [`packages/rest/src/lib/utils/constants.ts`](https://github.com/discordjs/discord.js/blob/14.27.0/packages/rest/src/lib/utils/constants.ts) at tag 14.27.0:

```js
globalRequestsPerSecond: 50,
offset: 50,
rejectOnRateLimit: null,
retries: 3,
timeout: 15_000,
hashSweepInterval: 14_400_000,  // 4 hours
hashLifetime: 86_400_000,       // 24 hours
handlerSweepInterval: 3_600_000 // 1 hour
```

With `rejectOnRateLimit: null` (documented as: routes matching the filter "throw `RateLimitError`s. All other request routes will be queued normally"), discord.js **queues** every edit. Fire 40 edits a second and you get no 429 and no exception — you get a growing backlog, and the message the user sees falls further and further behind the model. On a long generation the visible text can end up minutes stale.

**Therefore: coalesce, do not queue.** The correct shape is a single-slot buffer, not a stream of edits:

- Keep the latest full text in a variable; keep at most **one** edit in flight.
- On each token batch, update the variable. If an edit is in flight, mark dirty and return. When it settles, if dirty, issue one edit with the newest text.
- Add a floor of **1000–1500 ms** between edits. This is my recommendation, not a documented limit; it is chosen to sit comfortably inside any plausible per-route bucket while still reading as live to a human.
- Never let intermediate states queue up. Dropping them is free — only the final state is correct.
- Roll to a new message when the current one reaches the 2000-character budget, and stop editing the old one.

Also worth wiring for observability: the REST manager emits `rateLimited` (`RESTEvents.RateLimited`) and `invalidRequestWarning`. Set `invalidRequestWarningInterval` to a non-zero value — it defaults to `0`, meaning no warnings — so you find out before the 10,000-invalid-requests-per-10-minutes IP restriction bites.

**Is there anything better in 2026?** No, but Components V2 is worth knowing about. From the [Component Reference](https://docs.discord.com/developers/components/reference), setting message flag `1 << 15` (`IS_COMPONENTS_V2`, decimal 32768):

> - The `content` and `embeds` fields will no longer work but you'll be able to use Text Display and Container as replacements
> - Attachments won't show by default - they must be exposed through components
> - The `poll` and `stickers` fields are disabled
> - Messages allow up to 40 total components

And critically: "Once a message has been sent with this flag, it can't be removed from that message."

Text Display (type `10`) holds markdown and is documented as behaving "extremely similar to the `content` field of a message", with the advantage that you can have several of them and control layout — so a streamed answer could grow as multiple Text Displays inside a Container rather than one ballooning `content`. The reference table for Text Display lists no per-field character limit. Discord's builders for these ship in discord.js 14.27.0.

My recommendation: ship v1 on plain `content` plus chunking. Components V2 is a presentation upgrade with real trade-offs (no `content`, irreversible per message, attachments need explicit exposure) and it does not solve the streaming problem. Revisit it for structured output like tool-call traces or status panels.

Polls are not relevant to a conversational agent.

### 7. Rate limits generally

From [Rate Limits](https://docs.discord.com/developers/topics/rate-limits):

- **Global:** "All bots can make up to 50 requests per second to our API." Independent of per-route limits.
- **Per-route:** exist for many endpoints, numbers unpublished, keyed by top-level resource (`channel_id`, `guild_id`, `webhook_id`) — so two different channels are separate buckets.
- **Headers:**

  | Header | Meaning (verbatim) |
  |---|---|
  | `X-RateLimit-Limit` | "The number of requests that can be made" |
  | `X-RateLimit-Remaining` | "The number of remaining requests that can be made" |
  | `X-RateLimit-Reset` | "Epoch time (seconds since 00:00:00 UTC on January 1, 1970) at which the rate limit resets" |
  | `X-RateLimit-Reset-After` | "Total time (in seconds) of when the current rate limit bucket will reset" |
  | `X-RateLimit-Bucket` | "A unique string denoting the rate limit being encountered" |
  | `X-RateLimit-Global` | returned only on 429s caused by the global limit |
  | `X-RateLimit-Scope` | on 429s; `user`, `global`, or `shared` |

- **429 body:** `retry_after` (float seconds), `global` (bool), optional `code` (int).
- **Invalid request limit:** "IP addresses that make too many invalid HTTP requests are automatically and temporarily restricted from accessing the Discord API. Currently, this limit is 10,000 per 10 minutes." Counted responses are 401, 403, and 429.
- "429 errors returned with `X-RateLimit-Scope: shared` are not counted against you."
- Emoji routes "do not follow the normal rate limit conventions" and are "specifically limited on a per-guild basis".

**What discord.js does for you.** All of it, essentially. `@discordjs/rest` parses the headers, maintains per-bucket handlers keyed by the returned hash, pre-emptively throttles to `globalRequestsPerSecond: 50`, adds an `offset: 50` ms cushion to every rate-limit calculation, retries `retries: 3` times on 5xx and timeouts, and aborts a request after `timeout: 15_000` ms. You should not implement a rate limiter. You should implement *coalescing*, which is a different thing and which discord.js cannot do for you because only you know that an intermediate edit is disposable.

### 8. Typing indicator

`POST /channels/{channel.id}/typing`. From [Channel](https://docs.discord.com/developers/resources/channel): the indicator "expires after 10 seconds", and the docs note bots should generally avoid it, though it is appropriate "when processing commands that require computation time" — which is precisely cadence-agent's case.

To keep it alive across a long model call: send it once at the start, then re-send on an interval of roughly 8 seconds until the first output goes out. Clear the interval in a `finally` block so a thrown model error does not leave the bot typing forever. Cost is negligible against the 50 req/s global budget.

Once you start editing a streamed reply, stop the typing indicator — the growing message is the better progress signal, and both at once reads as broken.

### 9. Attachments and images

**Size limit, verbatim** from [API Reference](https://docs.discord.com/developers/reference): "The default limit is `10 MiB` for all users, but may be higher for users depending on their Nitro status or by the server's Boost Tier."

Assume **10 MiB** for the bot. Boost-tier and Nitro uplifts exist but I could not confirm the current numbers from a primary source, and a bot has no Nitro of its own — see [Unverified](#unverified).

**Receiving user images for a vision model.** Attachments arrive in `message.attachments`, each with a CDN `url`, `content_type`, `width`/`height`, and `size`. `attachments` is one of the fields gated by `MESSAGE_CONTENT`, so this works in DMs and on mentions without the intent, and is empty otherwise. Practical notes: validate `content_type` against what your model accepts rather than trusting the filename extension; enforce your own byte ceiling before downloading, using the `size` field; CDN URLs are signed and expiring, so if you need the image later, fetch and store the bytes rather than persisting the URL.

**Sending files back.** Upload is `multipart/form-data` with the JSON in a `payload_json` part and each file as `files[n]` with a `Content-Disposition` header carrying `filename` and `name`. discord.js wraps this as the `files` option on send. Two documented details worth knowing:

- Attachments can be referenced from embeds as `attachment://filename.png`, with supported formats "JPG, JPEG, PNG, WebP, and GIF".
- On **edit**, "the `attachments` array specifies which files remain attached. Files omitted from this array are removed." So a streamed edit loop that forgets to echo the existing `attachments` array will silently strip previously-sent files.
- `description` on an attachment is alt text, max 1024 characters. Set it — it is cheap accessibility.

### 10. Markdown differences

Discord renders a subset of markdown plus custom mention syntax. Model output cannot be assumed to render correctly.

Verified-supported syntax, taken from the [`@discordjs/formatters`](https://github.com/discordjs/discord.js/blob/14.27.0/packages/formatters/src/formatters.ts) helpers at tag 14.27.0 (each helper's return type states the literal syntax it produces):

| Feature | Syntax |
|---|---|
| bold | `**text**` |
| italic | `_text_` |
| underline | `__text__` |
| strikethrough | `~~text~~` |
| spoiler | `\|\|text\|\|` |
| inline code | `` `text` `` |
| code block | ```` ```lang\ncode\n``` ```` |
| quote | `> text` |
| block quote | `>>> text` |
| headings | `# `, `## `, `### ` — **levels 1–3 only** |
| subtext | `-# text` |
| masked link | `[text](url)` |
| suppress link embed | `<url>` |
| ordered / unordered list | `1. ` / `- ` |

The `HeadingLevel` enum in that file defines exactly `One = 1`, `Two`, `Three`. There is no level 4, 5, or 6.

Mention and special syntax, verbatim from [Message Formatting](https://docs.discord.com/developers/reference#message-formatting):

| Kind | Syntax |
|---|---|
| user | `<@USER_ID>` |
| channel | `<#CHANNEL_ID>` |
| role | `<@&ROLE_ID>` |
| slash command | `</NAME:COMMAND_ID>` |
| custom emoji | `<:NAME:ID>` / animated `<a:NAME:ID>` |
| timestamp | `<t:TIMESTAMP>` / `<t:TIMESTAMP:STYLE>` |
| guild navigation | `<id:TYPE>` |

Timestamp styles: `t` short time, `T` medium time, `d` short date, `D` long date, `f` long date + short time, `F` full date + short time, `R` relative. (`s` and `S` also appear in the table.) `R` is genuinely useful for an agent reporting when something happened.

**What to expect not to render.** Discord's markdown is a subset; tables, images (`![alt](url)`), horizontal rules, and headings above level 3 are not in the supported set above. `@discordjs/formatters` provides no helper for any of them. Absence of a helper is strong but not conclusive evidence — see [Unverified](#unverified). Either way, model output containing a markdown table will land in Discord as a pile of pipes, which argues for instructing the model in its system prompt to target Discord-flavoured markdown, or post-processing tables into fenced code blocks where the monospace alignment at least survives.

Two more things that matter because model output goes straight into a message:

- **Discord strips characters.** Verbatim: "Discord may strip certain characters from message content, like invalid unicode characters or characters which cause unexpected message formatting. If you are passing user-generated strings into message content, consider sanitizing the data to prevent unexpected behavior and using `allowed_mentions` to prevent unexpected mentions."
- **`allowed_mentions` defaults are dangerous for regular messages.** From [Allowed Mentions](https://docs.discord.com/developers/resources/message#allowed-mentions-object): in regular messages the default is `{"parse": ["users", "roles", "everyone"]}`; in interactions and webhooks it is `{"parse": ["users"]}`. So a model that emits `@everyone` in a normal `channel.send()` will attempt to ping the server. Discord validates against your permissions and against the mention actually being present, and `MENTION_EVERYONE` is required for `@everyone`/`@here` to fire — but do not rely on the permission being absent. **Set `allowed_mentions: { parse: [] }` on every outbound message by default in the adapter**, and opt in explicitly when the agent genuinely means to ping someone. `replied_user` defaults to `false`, which is the behaviour you want for replies.

---

## Structure and identity

### 11. Grouping primitives and the session boundary

Channel types, from [Channel](https://docs.discord.com/developers/resources/channel):

| Type | Value | Notes for cadence-agent |
|---|---|---|
| `GUILD_TEXT` | 0 | mention-triggered entry point |
| `DM` | 1 | **primary surface**; no `guild_id`, no permissions |
| `GROUP_DM` | 3 | treat as unsupported |
| `GUILD_ANNOUNCEMENT` | 5 | ignore |
| `ANNOUNCEMENT_THREAD` | 10 | ignore |
| `PUBLIC_THREAD` | 11 | good guild session boundary |
| `PRIVATE_THREAD` | 12 | good guild session boundary |
| `GUILD_FORUM` | 15 | each post is a thread; natural fit but guild-only |
| `GUILD_MEDIA` | 16 | ignore |

The hierarchy is guild → channel → thread, with DM channels sitting outside guilds entirely.

**The decisive constraint: threads are guild-only.** From [Threads](https://docs.discord.com/developers/topics/threads), `parent_id` "has been repurposed to store the id of the `GUILD_TEXT` or `GUILD_ANNOUNCEMENT` channel the thread was created in", and threads reuse the `guild_id` field. There is no thread inside a DM channel. Since DM is the primary interaction mode for a personal agent, **the session model cannot depend on threads.**

Trade-offs:

- **Session per user.** Simplest conceptually, and matches "my agent knows me". But it collapses a user's guild activity and DM activity into one context, so a question asked in a work server pollutes the private DM. Wrong granularity for context; right granularity for long-term memory.
- **Session per channel.** For a DM this is one session per user, which is what you want. For a guild text channel it is one shared session, which is what you want when several people are talking to the agent in one place. Uses one identifier that exists everywhere. Its weakness is that it never ends on its own: a DM channel is eternal, so context grows without bound and yesterday's unrelated task stays in the window.
- **Session per thread.** The cleanest isolation and the most legible to users — a new thread visibly means a new topic. But unavailable in DMs, subject to archival (see [13](#13-auto-threading)), and it makes every conversation a two-step ritual.

**Recommendation.** Key sessions on `channel.id` in all contexts, and own the lifecycle yourself:

- **DM:** the DM channel *is* the session container, so give the session an explicit lifecycle. An idle timeout (a few hours) rolls to a fresh session, and an explicit `/new` ends one immediately. Post a visible marker when a session rolls, so the user is never surprised about what the agent still remembers.
- **Guild text channel:** on mention, create a thread and run the session there. The thread gives you the boundary Discord otherwise withholds, and it keeps the parent channel clean.
- **Forum channel:** if used, one post is one session — that maps perfectly and needs no extra logic.

Because the key is always `channel.id`, all three cases are the same code path, and long-term memory keys off `user.id` independently of session. That separation is the important one: **session is conversational context and is disposable; scope is memory identity and is permanent.**

### 12. Stable identifiers for scoping

All Discord ids are snowflakes: 64-bit, transmitted as **strings** in JSON because they exceed `Number.MAX_SAFE_INTEGER`. From [API Reference](https://docs.discord.com/developers/reference), the layout is timestamp (42 bits, ms since the Discord epoch `1420070400000`), worker id (5), process id (5), increment (12). Store them as strings. Never parse one into a JS `number`.

| Identifier | Stability | Notes |
|---|---|---|
| `user.id` | **stable forever** | The one true identity. Immutable, never reused. |
| `username` / `global_name` / nickname | **changes freely** | Never key anything on these. Cache for display only. |
| `guild.id` | stable | Immutable while the guild exists. |
| `channel.id` | stable while the channel exists | Renaming does not change it; deleting is permanent and a new channel gets a new id. |
| thread id | stable while the thread exists | Archival does **not** change the id, so a thread-keyed session survives archive/unarchive. |
| DM `channel.id` | stable per bot–user pair | `POST /users/@me/channels` returns the existing channel if one exists. |
| `message.id` | stable forever | Useful as a durable anchor for the message you are editing. |

**Composite scope key.** Make it a string with a fixed field order, a namespace that anticipates other channels, and an explicit scope *type* so a lookup can never accidentally match across levels:

```
cadence:v1:<platform>:<scopeType>:<...ids>
```

Concretely:

```
cadence:v1:discord:user:<userId>                       # personal long-term memory
cadence:v1:discord:guild:<guildId>                     # shared guild knowledge
cadence:v1:discord:guild-user:<guildId>:<userId>       # per-user-per-guild
cadence:v1:discord:channel:<channelId>                 # conversational session state
```

Design notes that will save a migration:

- Include the version segment now. You will change this scheme.
- Include the platform segment now, since Slack, Telegram, and CLI are coming and their ids are not snowflakes and not globally unique against Discord's.
- Keep the DM scope as `channel:<dmChannelId>` for session state and `user:<userId>` for memory. Do not conflate them, even though in a DM they are one-to-one — that one-to-one relationship is exactly what breaks when you add guilds.
- For a CLI channel there is no real user id; synthesise a stable local one rather than special-casing null.
- The single-operator config is then just a policy that resolves every scope to one known `userId`, and multi-user is the removal of that policy — a config change, as intended.

### 13. Auto-threading

Can it? Yes, in guild channels. Should it? Yes there, never in DMs (impossible).

What it buys: a hard context boundary that is visible to the user, an uncluttered parent channel, and a durable id you can key a session on across restarts.

Permissions required, from [Permissions](https://docs.discord.com/developers/topics/permissions):

| Permission | Bit |
|---|---|
| `CREATE_PUBLIC_THREADS` | `1 << 35` |
| `CREATE_PRIVATE_THREADS` | `1 << 36` |
| `SEND_MESSAGES_IN_THREADS` | `1 << 38` |
| `MANAGE_THREADS` | `1 << 34` (only to archive/lock or view all private threads) |

Note the trap, verbatim: "Threads inherit permissions from the parent channel (the channel they were created in), with one exception: The `SEND_MESSAGES` permission is not inherited; users must have `SEND_MESSAGES_IN_THREADS` to send a message in a thread". A bot with `SEND_MESSAGES` but not `SEND_MESSAGES_IN_THREADS` creates a thread it cannot talk in. In forum/media channels, creating a thread needs only `SEND_MESSAGES`.

Limits and archival, verbatim from [Threads](https://docs.discord.com/developers/topics/threads):

- `auto_archive_duration` allowed values: **60, 1440, 4320, or 10080 minutes** (1 hour, 1 day, 3 days, 7 days).
- "Threads do not count against the max-channels limit in a guild, but there is a limit on the maximum number of active threads in a guild." **The number is not documented** — see [Unverified](#unverified).
- "Threads automatically archive after a period of inactivity. As a server approaches the max thread limit this timer will automatically lower, usually not below the `auto_archive_duration`. In very busy channels, threads set to a 7 day auto archive may archive earlier to help avoid the server becoming 'full')."
- "'Activity' is defined as sending a message, unarchiving a thread, or changing the auto-archive time."
- "The `auto_archive_duration` field previously controlled how long a thread could stay active, but is now repurposed to control how long the thread stays in the channel list."
- Archived threads are near-frozen: "Users cannot edit messages, add reactions, use application commands, or join archived threads." But "Sending a message will automatically unarchive the thread, unless the thread has been locked by a moderator."
- Unarchiving an unlocked thread "only requires the current user has already been added to the thread"; unarchiving a **locked** thread requires `MANAGE_THREADS`.

Practical consequences for the adapter:

- Archival is not a problem for correctness. The thread id is unchanged and posting unarchives it. Just never assume a thread you created is still active — handle the unarchive implicitly by sending.
- Locked threads *are* a problem. Detect `locked` and fail gracefully rather than retrying.
- Do not auto-thread in DMs, and do not auto-thread inside a thread (threads do not nest).
- One thread per conversation is right; one thread per *message* will approach the undocumented guild cap and, worse, will make Discord shorten everyone's archive timers. Reuse the active thread for a continuing conversation.
- Name threads from the user's first message, truncated. It is the only affordance users get for finding an old session.

---

## Operational

### 14. Hosting a long-running gateway connection

From [Gateway](https://docs.discord.com/developers/events/gateway):

**Connecting.** Cache the URL from Get Gateway / Get Gateway Bot and use it for initial connections, with explicit API version and encoding query parameters. Current stable API version is **v10**.

**Heartbeats.** On `Hello`, "your app should wait `heartbeat_interval * jitter` where `jitter` is any random value between 0 and 1, then send its first Heartbeat event", then heartbeat every interval thereafter. discord.js handles this.

**Reconnect triggers.** Attempt to reconnect when the app:

> 1. It receives a [Reconnect (opcode `7`)] event
> 2. It's disconnected with a close code that indicates it can reconnect...
> 3. It's disconnected but doesn't receive *any* close code.
> 4. It receives an [Invalid Session (opcode `9`)] event with the `d` field set to `true`.

**Resuming.** Needs three things: `session_id` from `Ready`, `resume_gateway_url`, and `seq` (last sequence number received) to replay missed events. Resume against `resume_gateway_url`, not the cached initial URL, with identical version and encoding. On `Invalid Session` with `d: false`, disconnect and re-identify fresh.

**Identify limits — read this twice.**

> Clients are limited to 1000 `IDENTIFY` calls to the websocket in a 24-hour period. This limit is global and across all shards, but does not include `RESUME` calls. Upon hitting this limit, all active sessions for the app will be terminated, the bot token will be reset, and the owner will receive an email notification. It's up to the owner to update their application with the new token.

Also: apps are limited by `max_concurrency` when identifying, "Number of identify requests allowed per 5 seconds", which is `1` for a small bot. Exceeding it yields `Invalid Session` (opcode 9).

The consequence for development is concrete. A file-watcher that restarts the process on every save burns one identify per restart. A crash-loop can burn hundreds. **Do not run a hot-reloading dev process against the production token**, and put a restart backoff on the supervisor. Resumes are free, so a well-behaved reconnect costs nothing; only full restarts count.

**Sharding.** Not needed. "Each shard can only support a maximum of 2500 guilds, and apps that are in 2500+ guilds *must* enable sharding." The [discord.js sharding guide](https://discordjs.guide/sharding/) adds that sharding "is only **required at 2,500 guilds**" and suggests planning around 2,000. A private single-guild bot is three orders of magnitude away. Route formula, for the record: `shard_id = (guild_id >> 22) % num_shards`. Above 150,000 guilds the shard count must be a multiple of the number Discord provides, and the identify budget rises to `max(2000, (guild_count / 1000) * 5)` per day.

**In-flight work across a restart.** Discord gives you nothing here, and this is the gap you have to close yourself.

- A resume replays missed *gateway events*, so a message sent while you were reconnecting will still arrive. That covers input.
- Nothing covers output. A model call in progress when the process dies is lost, and the half-written message you were editing stays half-written on Discord forever, with no indication anything went wrong.
- So: persist turn state (channel id, the id of the message you are editing, and the accumulated text) before starting the model call, and on boot, scan for turns marked in-flight. Either resume them or edit the orphaned message to say the turn was interrupted. Never leave a truncated reply silently sitting there — for a personal agent that is the difference between "it crashed" and "it lied to me".
- `message.id` is the durable handle for this. Store it, not a channel-relative position.
- Deduplicate on `message.id` for inbound messages, because a resume can redeliver and you do not want a double model call.

---

## Owner setup checklist

Hand this to the person who owns the Discord account. It assumes a **private, single-operator, single-guild bot**. Do the steps in order.

**A. Create the private guild (skip if one already exists)**

1. In the Discord client, click the `+` in the server list, choose **Create My Own**, and name it (e.g. `cadence`). Do not add anyone else.
2. Create a text channel in it, e.g. `#agent`. This channel is mostly a formality — the shared-guild relationship it creates is what makes DMs to the bot work.

**B. Create the application and bot user**

3. Go to <https://discord.com/developers/applications> and sign in.
4. Click **New Application**, name it, accept the terms, and click **Create**.
5. From the app's **General Information** page, copy the **Application ID**. You need it in step 11. (It is also the bot's user id.)
6. Open the **Bot** page in the left sidebar.
7. Turn **Public Bot** **OFF**. This prevents anyone else from adding the bot to their server. This is the single most important toggle for a private bot.
8. Leave **Requires OAuth2 Code Grant** **OFF**. Turning it on breaks the simple invite flow in step 12.

**C. Intents**

9. Still on the **Bot** page, find the **Privileged Gateway Intents** section and set:
   - **Presence Intent** — **OFF**.
   - **Server Members Intent** — **OFF**.
   - **Message Content Intent** — **OFF** for the DM-first design. Turn it **ON** only if you want the agent to read every message in guild channels without being @mentioned. It is a toggle with no review below 10,000 reachable users; above that it needs an application and annual renewal.
10. Click **Save Changes**. Nothing on this page takes effect until you do.

**D. Token**

11. On the **Bot** page, under **Token**, click **Reset Token** (a fresh app shows no token until you do), confirm, and copy the value.
    - This is shown **once**. Copy it now.
    - Put it in `.env` as `DISCORD_TOKEN=...` and confirm `.env` is in `.gitignore`.
    - Anyone with this string controls the bot. If it ever lands in a commit, a log, or a screenshot, come back here and reset it.

**E. Invite the bot to your guild**

12. Build the invite URL by substituting your Application ID from step 5:

    ```
    https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=377957239872
    ```

    - `permissions=377957239872` grants: View Channels, Send Messages, Read Message History, Add Reactions, Embed Links, Attach Files, Create Public Threads, Create Private Threads, Send Messages in Threads.
    - If you do not want the agent creating threads, use `permissions=117824` instead (View Channels, Send Messages, Read Message History, Add Reactions, Embed Links, Attach Files).
    - Absolute minimum, text only, no files or threads: `permissions=68608`.
    - To pre-select the server and stop yourself picking the wrong one, append `&guild_id=YOUR_GUILD_ID&disable_guild_select=true`. Get the guild id by enabling **Settings → Advanced → Developer Mode** in the Discord client, then right-clicking the server icon and choosing **Copy Server ID**.

13. Open that URL in a browser, choose your private server, click **Continue**, then **Authorize**.
14. Confirm the bot now appears in the server's member list, offline.

    The Developer Portal's **Installation** page and **OAuth2 → URL Generator** produce equivalent links through a UI. The URL above is from the documented parameter set and does not depend on the portal's current labels, so prefer it if the UI has moved.

**F. Verify**

15. Start cadence-agent with the token. The bot's status should go from offline to online in the member list.
16. In `#agent`, send a message that @mentions the bot. It should reply.
17. Right-click the bot in the member list, choose **Message**, and send it a DM. It should reply. **This is the important test** — it exercises the DM path, the `DIRECT_MESSAGES` intent, and the `Partials.Channel` requirement together.
18. If the mention works but the DM does not, the cause is almost always a missing `Partials.Channel` in the client options, not a permissions problem.
19. If both arrive but the agent behaves as if the message were empty, `MESSAGE_CONTENT` is off and something is reading a non-exempt message — expected in guild channels without an @mention, a bug anywhere else.

**G. Note for the developer**

20. Use a **second application with its own token** for local development. The 1000-identifies-per-24-hours limit is per app, and breaching it resets the token automatically. A hot-reloading dev loop pointed at the production token is how you lose it.

---

## Unverified

Everything below could not be confirmed against a primary source. It is flagged rather than stated as fact.

- **The 4000-character message limit.** Not present anywhere in the developer documentation. The docs consistently say `content` is "up to 2000 characters" for create and edit. 4000 appears only as the modal text input max and 4096 as an embed `description` cap. Secondary sources (SEO content sites) describe 4000 as a Nitro subscriber feature for human accounts. I found no primary source stating whether it applies to bots, and no reason to think it does. **Treat 2000 as the cap.**
- **"5 edits per 5 seconds per channel."** Widely repeated, not in the docs. Discord explicitly declines to publish per-route numbers and says "Rate limits should not be hard coded into your app." A 2016 entry in the `discord-api-docs` issue tracker references a 5/5 message create-and-edit limit, which is far too old to rely on. My 1000–1500 ms edit-floor recommendation is a safety margin, not a documented threshold.
- **Maximum active threads per guild.** The docs confirm a limit exists ("there is a limit on the maximum number of active threads in a guild") but never give the number. Community sources say 1000. Unconfirmed. The behaviour that actually matters *is* documented: as a guild nears the cap, archive timers shorten automatically.
- **Attachment size above the 10 MiB default.** The docs say only "may be higher for users depending on their Nitro status or by the server's Boost Tier" without numbers. The commonly cited tier figures (50 MB / 100 MB) and Nitro figures could not be confirmed; `support.discord.com` returned HTTP 403 to automated fetches. Assume 10 MiB.
- **Whether a shared guild is strictly required for a bot to DM a user.** Not stated in the developer docs. Discord support material and community discussion both indicate a bot cannot DM a user with whom it shares no server the user accepts DMs from, and there are standing feature requests to change this — which implies the restriction is real. Moot for this project, since setup step A establishes a shared guild.
- **Markdown features that do not render.** Tables, images (`![alt](url)`), horizontal rules, and headings above level 3 are absent from both the `@discordjs/formatters` helper set and the `HeadingLevel` enum (which stops at `Three`). That is strong circumstantial evidence but not an explicit statement of non-support. The canonical human-facing reference is Discord's "Markdown Text 101" support article, which returned HTTP 403 to automated fetches; the developer docs contain no markdown page at all (only the mention/formatting table under API Reference).
- **Components V2 total character limit.** The reference documents "up to 40 total components" per message and gives no character limit for a Text Display `content` field. A 4000-character aggregate is often cited; not confirmed.
- **Developer Portal UI labels** in the setup checklist. The Bot page's "Privileged Gateway Intents" section name is quoted from the developer docs and is reliable. Button labels such as "Reset Token", "New Application", and the Installation page layout are from the portal as it has recently stood; Discord changes this UI without notice. The OAuth2 URL in step 12 is built from the documented parameter set and is the more durable path.

---

## Sources

- [Gateway (events) — intents, privileged intents, identify limits, sharding, resume](https://docs.discord.com/developers/events/gateway) · [raw](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx)
- [Getting Started with Privileged Intent Review](https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review)
- [You Might Not Need a Privileged Intent](https://docs.discord.com/developers/gateway/you-might-not-need-a-privileged-intent)
- [Message resource — content/embed limits, allowed_mentions, create/edit](https://docs.discord.com/developers/resources/message) · [raw](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx)
- [Channel resource — channel types, typing indicator, thread fields](https://docs.discord.com/developers/resources/channel)
- [User resource — Create DM](https://docs.discord.com/developers/resources/user)
- [Application resource — install contexts](https://docs.discord.com/developers/resources/application)
- [Threads](https://docs.discord.com/developers/topics/threads) · [raw](https://github.com/discord/discord-api-docs/blob/main/developers/topics/threads.mdx)
- [Rate Limits](https://docs.discord.com/developers/topics/rate-limits) · [raw](https://github.com/discord/discord-api-docs/blob/main/developers/topics/rate-limits.mdx)
- [Permissions — bit values](https://docs.discord.com/developers/topics/permissions)
- [OAuth2 — bot authorization URL, scopes, guild_id/disable_guild_select](https://docs.discord.com/developers/topics/oauth2)
- [API Reference — API version, snowflakes, uploading files, message formatting](https://docs.discord.com/developers/reference)
- [Component Reference — Components V2, IS_COMPONENTS_V2](https://docs.discord.com/developers/components/reference)
- [Interactions: Receiving and Responding — 3s ack, 15min token, deferral](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [discord.js releases](https://github.com/discordjs/discord.js/releases)
- [discord.js v14.27.0 README](https://github.com/discordjs/discord.js/blob/14.27.0/packages/discord.js/README.md) and [main README](https://github.com/discordjs/discord.js/blob/main/packages/discord.js/README.md)
- [`@discordjs/rest` default options](https://github.com/discordjs/discord.js/blob/14.27.0/packages/rest/src/lib/utils/constants.ts) and [option docs](https://github.com/discordjs/discord.js/blob/14.27.0/packages/rest/src/lib/utils/types.ts)
- [`@discordjs/formatters`](https://github.com/discordjs/discord.js/blob/14.27.0/packages/formatters/src/formatters.ts)
- [`@discordjs/builders` index (Components V2 builders)](https://github.com/discordjs/discord.js/blob/14.27.0/packages/builders/src/index.ts)
- [discord.js guide: Partials](https://discordjs.guide/popular-topics/partials)
- [discord.js guide: Sharding](https://discordjs.guide/sharding/)
- npm registry metadata for `discord.js`, `@discordjs/core`, `seyfert`, `@sapphire/framework`, `oceanic.js`, `discord-api-types` (fetched 2026-07-25)
