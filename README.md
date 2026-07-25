# cadence-agent

An AI agent that lives in your chat.
Discord first, more channels later.

In the same family as [Hermes Agent](https://github.com/NousResearch/hermes-agent) and [Pi](https://github.com/earendil-works/pi) — both are read as reference designs, neither is forked.

## Status

Early. The toolchain and config layer work; nothing talks to Discord yet.

The architecture is being worked out on a wayfinder map: **[issue #1](https://github.com/seahsky/cadence-agent/issues/1)**.
Each seam under `src/` has a README naming the ticket that decides it, so an empty directory tells you what it is waiting on rather than leaving you guessing.

## Shape

| Seam | What it does | Decided by |
| --- | --- | --- |
| `src/channel` | Communication surfaces. Discord first. | [#12](https://github.com/seahsky/cadence-agent/issues/12) |
| `src/provider` | Model backends: OpenRouter (per token) and `claude -p` (subscription). | [#7](https://github.com/seahsky/cadence-agent/issues/7) |
| `src/agent` | The loop — prompt, call, tools, stop. | fog, downstream of #7 |
| `src/memory` | Short-term and long-term, and the links between them. | [#10](https://github.com/seahsky/cadence-agent/issues/10) |
| `src/storage` | Persistence for sessions and memory. | [#11](https://github.com/seahsky/cadence-agent/issues/11) |
| `src/config` | Environment loading, validated at boot. | done |

Two model backends is the interesting constraint. OpenRouter is a stateless HTTP API billed per token; `claude -p` is a subprocess that owns its own loop, tools, and context, billed against a Claude subscription. They are not the same kind of thing, and pretending otherwise is the fastest way to a leaky abstraction — hence [#7](https://github.com/seahsky/cadence-agent/issues/7).

## Running it

Requires Node 22.19+ (see `.nvmrc`) and pnpm.

```sh
pnpm install
cp .env.example .env   # then fill in what you have
pnpm dev
```

Other scripts:

```sh
pnpm check        # typecheck + lint + test, the whole gate
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome check .
pnpm lint:fix     # biome check --write .
pnpm test         # vitest run
pnpm build        # tsc --build, output to dist/
```

## Stack

TypeScript 7 with `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
Biome for lint and format, vitest for tests, zod for validating anything crossing an external boundary.
Functional by default; classes only for connectors to external systems.

## Docs

- `CONTEXT.md` and `docs/adr/` — domain decisions.
- `docs/research/` — research findings, each marking its claims verified or uncertain.
- `docs/agents/` — how agents should work in this repo: the issue tracker, triage labels, domain conventions.
