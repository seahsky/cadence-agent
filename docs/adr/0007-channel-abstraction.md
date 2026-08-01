# The channel owns the projection onto the entry tree, and declares no capabilities

A channel is not a transport.
It is the layer that turns a platform's native gestures into cadence's domain and back, which makes it the only place a platform primitive is allowed to appear.

Two decisions carry the rest.
**The adapter owns the projection onto the entry tree**, so nothing above it knows what a thread is.
**No adapter declares capabilities**, so nothing above it branches on which surface it is talking to.

The test throughout is the one the ticket set: adding Slack later touches only `src/channel/slack/`.

## The projection lives in the adapter

ADR 0001 fixed both halves of a mapping.
The domain half: a channel holds one entry tree, a branch is a path, a fork point is an entry.
The Discord half: a branch is a thread, a fork point is the message a thread was started from, and an edit forks a revision at the superseded entry's parent.

The adapter owns that mapping.
It consumes `messageCreate`, `messageUpdate` and thread metadata, and emits an inbound entry that already carries a resolved `parentEntryId` and a `fork` of `continue` or `revise`.
The word "thread" does not appear above `src/channel/discord/`.

The alternative was emitting transport facts (`channelId`, `threadId`, `replyToId`, `isEdit`) and resolving them above.
It fails on the first line of the second adapter.
Slack threads are one level deep and never nest, Discord threads carry a real parent message id, a CLI has neither, and under that alternative every one of those differences becomes a conditional in shared code.
Keeping the projection in the adapter is what lets `CONTEXT.md` stay the interface, which is what that glossary being deliberately channel-agnostic was always for.

The cost is real and taken deliberately: the adapter is a projection layer with persistence, not a pipe.
What it needs to do that job it receives as injected ports, below.

## A dispatcher sits between the channel and the agent

The channel does not call the agent, and the agent does not touch the channel.
A thin runtime subscribes to the inbound source, owns per-session turn lifecycle, and calls the agent.

The forcing case is already in ADR 0001: "if a turn is in flight for that entry, cancel it and restart in the trunk."
Something has to hold a registry of in-flight turns keyed by session, cancel one, and start its replacement.
The channel is the wrong owner, because it would then know what a turn is.
The agent is the wrong owner, because it is a function of one request.
Letting the agent consume the source directly does not avoid this: the consumer either serialises every session globally or fans out, and once it fans out it is a dispatcher under another name.

This is also what makes the interface small.
With turn lifetime elsewhere, the adapter's whole surface is a lifecycle, a source, and a way to send.

The gateway pushes whether cadence is ready or not, so the source is a **bounded** buffer with a stated overflow policy rather than an unbounded queue that turns a slow turn into a memory leak.
Overflow is reported on the operator port.

## Outbound is a stream the channel consumes

```ts
reply(at: ReplyTarget, deltas: AsyncIterable<string>): Promise<NativeId[]>
```

The channel pulls until exhaustion.
It is not handed a `push`/`finish` handle.

Four reasons, in descending weight.
The typing indicator must stop in a `finally` or a thrown model error leaves cadence typing forever, and under a consumed stream that `finally` is inside the adapter and structurally cannot be forgotten.
Cancellation composes for free, because aborting the iterable ends the `for await` and settles the partial reply.
A surface that cannot stream is not a special case, since a CLI or an email adapter drains the iterable and emits once.
And it is one method rather than three, which was the ticket's own bar.

**The payload is text deltas and nothing else.**
The provider's `TurnEvent` from ADR 0003 was rejected outright: it carries tool calls, headroom and `notionalCost`, none of which a communication surface has business seeing, and reusing it would put a provider import in every adapter.
A richer channel-facing union was rejected on YAGNI, because both candidate payloads dissolve.
Attachments need no event, since "past roughly three chunks, send a file instead" is a rendering decision made from text the adapter already has.
Status notices need no event, since the growing message is the progress signal and the research is explicit that a typing indicator and a streaming edit at once reads as broken.

**A reply is one entry and many native ids.**
Chunking at 2000 characters means one turn lands as several Discord messages, so `reply` returns the set of ids it produced.
That is also what lets a revision clean up after itself: the adapter knows which messages belonged to the superseded entry, which is the orphan problem ADR 0001 flagged when a re-run produces a different chunk count.

**The iterable may throw, and rendering the interruption is the channel's job.**
A model that dies at 400 characters otherwise leaves a message that just stops mid-sentence, and silence is indistinguishable from a slow model.
On Discord the marker is a `-# ` subtext line appended to the last chunk, which is one more edit through the mechanism the reply already uses.
It stays out of the payload type for the same reason chunking does: only the surface knows how to say "this broke" in its own idiom.

## No capability declarations, and unsupported operations throw

The four differences the ticket named are streaming edits, threads, character limits and markdown dialect.
All four are rendering, and rendering is entirely the adapter's.
Ask what the agent would do with `supportsStreaming: false` and there is no answer, because it emits text deltas either way.
A flag nothing branches on exists only to be logged.

Threads look like the exception and are not.
With the projection in the adapter, a surface without a branching primitive simply never emits a fork and its tree is a line.
The agent reads a tree either way.

ADR 0003 litigated this shape one seam over and rejected `supportsTools: false` as "reintroducing exactly the capability-flag shape this seam removed."
Deciding the opposite here would leave cadence with two seams that disagree about the same question.

That ADR's positive rule ports with it.
**Unsupported operations throw rather than silently no-op.**
The live case is `branch`, which ADR 0001 permits on an explicit request in the current turn and therefore arrives as a model-invoked action.
On a CLI it throws, the throw becomes a tool error the model reads, and the model works around it.
That is adaptation without negotiation, at no cost in interface surface.

## Dialect is translated in the adapter, in both directions

Discord takes a subset of markdown: headings 1 to 3 only, no tables, no images, no horizontal rules.
The model emits ordinary CommonMark and **the adapter downconverts**, rather than the system prompt instructing the model to target Discord.

Instructing the model puts the word "Discord" inside prompt assembly, and with a second channel that becomes per-channel prompt text, which is a capability declaration with the serial numbers filed off.
It is also unreliable in a way a transform is not: an instruction about output format is a request, a transform is a guarantee, and cadence would need the transform as a backstop regardless.

The cost is that this is a **stream**, not a document.
A table cannot be converted until its last row arrives, so the adapter holds an open block back and that part of the reply visibly lags.
The mitigating fact is that the machinery is required anyway: fenced code blocks must be tracked across chunk boundaries and reopened with their language, so an incremental block-level scanner exists whether or not tables are translated.

One component in the Discord adapter therefore owns block scanning, dialect downconversion, chunking under a 2000-character budget, fence repair across chunks, and rolling to a new message.
Alongside it, two non-negotiable defaults from the research: a single-slot coalescing edit buffer with a floor of 1000 to 1500 ms rather than a queue of edits, and `allowed_mentions: { parse: [] }` on every outbound message, because a plain `channel.send` defaults to parsing `@everyone`.

Translation runs inbound too.
Raw content carries `<@1234>`, which reaches a model as a meaningless snowflake, so the adapter substitutes display names and keeps the ids in a side field.

## The operator surface is a port, not a channel

The ticket asked whether the operator channel is a second channel instance.
It is neither, and the confusion is two things wearing one word.

`CONTEXT.md` defines a channel as a durable conversational place holding exactly one entry tree.
The operator surface holds no entry tree, opens no sessions, has no branches and carries no memory scope: it fails the definition on every clause.
But the adapter is not a channel either.
There is one Discord bot with one gateway connection serving every destination in the guild, and a second connection is actively hostile, since 1,000 IDENTIFYs in 24 hours resets the bot token and a crash loop reaches that.

So three things, named separately:

- **Adapter**, one per platform, owning the connection, emitting inbound for every destination and sending to any of them.
- **Channel**, the domain term, a destination holding an entry tree.
- **Operator surface**, a destination never subscribed for inbound, never assembled into context, receiving structured notices.

The operator surface is exposed as a one-method port, `notify(notice)`, implemented by binding the adapter to a configured destination id.
Storage and memory depend on that port and never import the channel layer, which is what keeps ADR 0005's "a memory failure is never swallowed" from dragging Discord into `src/storage`.
It is a field on the adapter rather than a method, so the composition root hands `adapter.notify` to storage and there is no general-purpose `send` for anything to reach for.

**A notice is a discriminated union, never a pre-rendered string.**
ADR 0005 requires a purge confirmation to state the date the destroyed content ages out of backups, and Discord renders `<t:…:D>` and `<t:…:R>` natively.
That only works if the notice carries a `Date` and the adapter formats it.
A string throws the affordance away, makes notices untestable, and forecloses a second sink.

## Owner commands are a second inbound kind

The inbound source emits `entry` and `command`.
ADR 0004 requires `forget`, `purge` and `redact` to be recognised before the agent loop sees them, since routing a destructive operation through the model fires it on the model's reading of intent.

**Discord uses real slash commands, not a prefix convention.**
The reason is not ergonomics.
`interactionCreate` is a different gateway event from `messageCreate`, so a command is structurally incapable of being mistaken for conversation, whereas a prefix means parsing every message and hoping nobody starts a line with the sigil while discussing shell scripts.
For the one path that rewrites git history, "structurally cannot be confused" is worth more than "works everywhere", and the platforms without slash commands have argv, which is the same guarantee.

**The domain declares the command set and the adapter registers it.**
A list of descriptors with typed parameters lives in the domain; the Discord adapter translates it into slash-command registration at boot and validates inbound arguments against it before emitting.
That is what makes Slack a translation rather than a reimplementation.

**Ack-and-defer does not appear in the interface.**
The command event carries one `respond(result)`.
The adapter defers immediately and invisibly on receipt, ephemerally, buying 15 minutes, so a handler that takes a minute to run `git filter-branch` needs to know nothing.
An `ack()` in the interface would be a lifecycle every caller has to remember, which is what the consumed-stream reply already refused.

Authorization sits in two places doing two different jobs: native permission gating at registration, so the commands do not appear in other members' UI, and a real owner check above the adapter, because who may destroy memory is policy and not transport.

## The inbound shape

One rule for the whole set: a field belongs in the shape only if the agent's answer would change because of it.

**Required.** `origin`, `fork` (`continue` or `revise`), resolved `parentEntryId`, native ids, timestamp, and mention-resolved text.

**A quote pointer, which is not a fork point.**
Discord's plain reply and Discord's thread are different gestures, and ADR 0001 assigned meaning only to the thread.
If a plain reply set `parentEntryId`, every casual reply would fork the tree and the projection would stop meaning anything.
So a reply to something other than the preceding entry lands as `quotes`, a hint the agent may use and that is structurally inert.

**Attachment metadata, not bytes, and not a URL.**
ADR 0005 puts attachment bytes in a content-addressed store outside both stores, so a transport that writes blobs has grown a second job.
But a bare URL cannot cross the seam either: Discord's CDN links are signed and expiring, and a Slack file needs an auth header, so whoever fetched would need per-platform knowledge.
The adapter therefore exposes `fetchAttachment(ref)` and storage calls it.
Platform auth stays inside, blob storage stays outside.

**Reactions are out**, deliberately.
They are a genuinely useful agent affordance and a genuinely undecided one: not entries, needing a second gateway intent and `Partials.Reaction`, and with nothing in the memory design saying what a 👍 means.
That is fog, not a v1 field.

**Deletions are out**, also deliberately.
A user deleting a Discord message does not delete the entry.
ADR 0001 retains dead paths so the record stays honest, and ADR 0005 built `purge` and `redact` as the real erasure path with an audit row and a backup ageing-out date.
Letting a client-side gesture silently rewrite the log would undercut both.

## Errors are absorbed or go to the operator, never to the agent

The decisive case is a failed send.
Handing "missing `SEND_MESSAGES`" to the agent produces an apology it cannot deliver, because the delivery mechanism is what failed.
A failure in the reply path is structurally unreportable through the reply path.

**Absorbed.** Rate limits and 5xx entirely, since `@discordjs/rest` already parses the headers, keeps per-bucket handlers, pre-throttles to 50 requests a second and retries three times.
No retry layer is added on top: a second one stacks delays and makes an already-stale streamed message staler, and the research is explicit that the failure mode here is latency rather than errors.
Gateway drops are absorbed too, since the library reconnects.

**Surfaced on the operator port.** Permission and permanent send failures, inbound buffer overflow, and `invalidRequestWarning`, whose interval must be set explicitly because it defaults to off and the consequence of missing it is a temporary IP restriction at 10,000 invalid requests per 10 minutes.

**A mid-reply send failure aborts the reply.**
Skipping the bad chunk and sending the next produces an answer with a hole in the middle, which reads as cadence being incoherent rather than broken.
Abort, render the interruption marker if it can be sent, notify the operator either way.

**The IDENTIFY budget is deliberately not settled here.**
The adapter may refuse to reconnect past a configured budget and say so on the operator port, but the real guard is process supervision, which belongs to deployment.

## Identity stops at native ids

The adapter emits an `origin` record and never imports `Scope`.
ADR 0002 already defines `resolveScope(inbound)` returning a read set and a write scope, and makes the storage handle reachable only through a resolved scope.
A transport that constructs scopes is a transport that can construct the wrong one, against that ADR's stated bar that scope be a function the call site cannot bypass.

**`origin.channelId` is always the trunk channel id, never the thread id**, including for an entry that arrived in a thread.
ADR 0001 makes that identifier the scope key and ADR 0005 fixes an episodic entry's scope to the trunk channel.
Since the adapter is the only thing that knows a thread's trunk, it is the only thing that can honour this.
A thread id must not be constructible into a scope anywhere in the system.

## What the adapter depends on

Owning the projection means needing things the adapter cannot import.
All three arrive as narrow function-shaped ports, injected at a composition root.

```ts
type EntryIds  = {
  toEntry(native: NativeId): Promise<EntryId | null>
  bind(entry: EntryId, native: NativeId[]): Promise<void>
}
type EditJudge = (before: string, after: string) => Promise<"material" | "cosmetic">
type Notify    = (notice: Notice) => Promise<void>
```

`EntryIds` exists because resolving a fork point is a native-id lookup and a reply writes one entry to many native ids.
Importing `src/storage` instead would put a database handle in the channel layer and kill ADR 0002's module-private-handle rule.

`EditJudge` exists because ADR 0001 requires a cheap model call to decide whether an edit changed intent, since no edit-distance heuristic separates `teh`→`the` from `don't`→`do`.
Importing `src/provider` instead would leak ADR 0006's routing policy sideways into a transport.
The rejected alternative was emitting a raw `edit` event and deciding above, then calling back to create the thread: that splits one decision across the seam, in the single case where doing so is least defensible.

The adapter's entire outside world is three functions and a config record, so a test drives it with three fakes and no database, no model and no gateway.

## The interface

```ts
interface ChannelAdapter {
  readonly platform: Platform
  start(): Promise<void>
  stop(): Promise<void>
  inbound(): AsyncIterable<Inbound>                        // entry | command
  reply(at: ReplyTarget, deltas: AsyncIterable<string>): Promise<NativeId[]>
  branch(from: EntryId, title: string): Promise<EntryId>   // throws where unsupported
  fetchAttachment(ref: AttachmentRef): Promise<ReadableStream>
  readonly notify: Notify
}
```

Constructed as `createDiscordChannel({ entryIds, editJudge, config })`.

## Consequences

- `src/channel/` holds the seam and the ports; `src/channel/discord/` holds the adapter. Slack is `src/channel/slack/` and touches nothing else.
- **`src/domain/` is new**, for the vocabulary types the seams share: `EntryId`, `Origin`, `Scope`. This decision forces it, because the adapter must speak `EntryId` while being forbidden from importing storage, so those types can live in neither.
- **`src/runtime/` is new**, for the dispatcher. Not `src/agent/`, whose job is to assemble a prompt, call a provider, run tool calls and stop, which is a function of one request. Cancellation, per-session serialisation and the in-flight registry are a lifetime concern and would quietly turn the agent into a stateful service.
- `CONTEXT.md` gains a **Surfaces** section (adapter, destination, operator surface, notice, command, native id, origin) and a **quote** term under conversation structure. It also drops "surface" from the words to avoid for *channel*, which was incoherent once the operator surface needed a name of its own.
- The Discord adapter needs `Partials.Message` to receive an edit to an uncached message, and a no-op filter on `messageUpdate`, which also fires when a link unfurls with content unchanged. Both were flagged as missing from `docs/research/discord-channel-layer.md` by ADR 0001 and are implementation requirements, not choices.
- Reactions and deletions return as their own effort if they return at all.
