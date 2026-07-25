# One entry tree per channel, with sessions as spans and branches as threads

cadence keeps Pi's conversation tree and uses Discord threads as the navigation affordance Pi needs a TUI for.
What that left unsettled is what a session is, given that a channel never ends.

**A channel holds exactly one entry tree, running for the life of the channel.**
A session is a labelled span over that tree, not a container of one.
Spans are delimited by boundaries, and a boundary is a node that substitutes a digest for everything above it on its own path.
That makes a session roll and a mid-session compaction the same act rather than two mechanisms that have to agree with each other.

Sessions roll after eight hours idle or on an explicit reset.
The successor opens with the scope brief, the fact index, and exactly one inherited digest: the immediately preceding session's.
A digest is computed only from the entries its own boundary replaces and never from another digest, so inheritance goes one hop and stops.
This is the guard against the summarisation drift the research found in both Hermes and Pi.

## Why the tree is not partitioned per session

The forcing scenario is forking off an old entry.
Work through a problem on Monday, let the session roll overnight, then on Tuesday start a thread on Monday's message about the part you want to revisit.

Under a per-session tree that entry sits in a closed tree and needs a special case, and the special case does not survive contact.
You have to decide how far up the imported entry's ancestry the context walk goes.
Stopping at the entry throws away everything that made it mean anything; walking its ancestors puts you back in the old session's tree, which is the partition dissolving under pressure.

With one continuous tree there is no mechanism at all.
The walk goes leaf to root, straight up Monday's entries.
Getting Monday's raw context is the correct answer rather than a leak, because clicking that specific message is what asked for it.

The cost is that a session no longer owns its entries structurally.
Consolidation is defined over entries stamped with a session id, so a Tuesday branch off a Monday entry is stamped with Tuesday's session while sitting inside Monday's span.
That is odd to read and harmless in practice.

## Two gestures, two fork points

Discord gives two native gestures that both carry a message id for free, and they mean different things.

| Gesture | Fork point | Meaning |
| --- | --- | --- |
| Start thread on an entry | that entry | explore onward from here |
| Edit an entry | that entry's parent | supersede it and re-run |

An edit is the agent-TUI "let me rephrase that".
It does not continue from the entry, it replaces it, so the branch it creates is a revision and the original path becomes dead: retained so the record stays honest, never assembled into context.

Both project as threads, so branch-to-thread stays total.
The alternative considered was re-rooting an edit in place and editing cadence's own reply, which creates no threads at all.
It was rejected because it hides the original exchange, and because a chunked reply re-run produces a different number of messages and leaves orphans behind.

## What stops edits spawning threads

Editing is a far cheaper gesture than starting a thread, and thread count is the one thing that degrades a guild server-wide, because Discord shortens archive timers for everything as a guild approaches its active-thread cap.

Four guards, three structural and one a judgement:

- **No-op filter.** `messageUpdate` also fires when a link unfurls into an embed, with content unchanged. Compare normalised content and ignore no-ops. This is a correctness requirement, not a tuning choice.
- **Descendants guard.** No descendants means nothing was built on the entry, so an edit amends it and forks nothing. If a turn is in flight for that entry, cancel it and restart in the trunk.
- **One revision thread per entry.** Later edits of the same entry re-root inside the existing thread rather than creating another. Thread count is bounded by distinct entries edited after they were answered, not by keystrokes.
- **Materiality check.** A cheap model call decides whether the edit changed intent, because no edit-distance heuristic can separate `teh` to `the` from `don't` to `do`. When it rules an edit cosmetic, cadence marks the entry visibly, so a wrong verdict never reads as the gesture being broken.

Cadence creates a thread only in direct response to a deliberate act in the current turn, whether an edit or an explicit request to branch from an entry it looks up.
Never on its own judgement and never from a background pass.
That is what keeps the undocumented active-thread cap self-limiting rather than something to defend against.

## What the trunk sees of a branch

The trunk carries one line per sibling branch under the current session: title, turn count, last active.
The branch summary is stored and pulled on demand.

Auto-injecting summaries would defeat the isolation that was the reason to fork, and would spend always-on budget on every branch ever touched, competing with the brief and the fact index for the same one-to-two-thousand-token attention window.
Injecting nothing hits the worst read failure the memory research named, where the agent does not know a relevant memory exists and therefore never searches for it.
A pointer solves knowing it exists at a fixed cost, and bounds itself for free: pointers stop at the session boundary, because anything older is already represented by that boundary's digest.

Compaction inside a branch is therefore invisible to the trunk.
A branch boundary sits on the branch's own path, which the trunk never walks, and the on-demand summary is computed from the branch's live path with its own boundaries already applied.

## Consequences

- The map's note that "the session key is the trunk channel id" is wrong under this decision. That identifier is the scope key. A session has its own id.
- `#13` needs the thread-capable invite, `permissions=377957239872`.
- Two Discord facts are missing from `docs/research/discord-channel-layer.md` and implementation will hit both: `messageUpdate` firing on link-unfurl with unchanged content, and `Partials.Message` being required to receive an edit to an uncached message.
- The materiality check is the first job that is latency-bound but not user-facing text, which makes it an input to the routing decision in `#8`.
