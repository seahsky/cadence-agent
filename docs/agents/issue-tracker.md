# Issue tracker: GitHub (via MCP)

Issues and PRDs for this repo live as GitHub issues in `seahsky/cadence-agent`.

## The `gh` CLI is banned in this repo

Do not shell out to `gh` for any reason.
`.claude/settings.json` denies `Bash(gh)` and `Bash(gh:*)`, so the calls fail rather than silently working.

All GitHub operations go through the **`github` MCP server** (`https://api.githubcopilot.com/mcp/`, configured at user scope).

## Authentication

The server authenticates with a GitHub **fine-grained PAT** scoped to this repo.

- The token lives in `.claude/settings.local.json` under `env.GITHUB_MCP_PAT`, which is gitignored.
- The user-scope MCP config references it as `Authorization: Bearer ${GITHUB_MCP_PAT}`, so no token is stored in `~/.claude.json`.
- `.worktreeinclude` copies `.claude/settings.local.json` into every worktree Claude Code creates, so the token is present there too.

Git itself does not use this token.
Push and fetch authenticate through the system credential helper, and worktrees share the main checkout's `.git` directory.

## Resolving tool names

Tool search is enabled, so the server's tool schemas are deferred rather than loaded at session start.
Resolve the exact tool for an operation with `ToolSearch` before calling it — for example `ToolSearch("+github issue create")` or `ToolSearch("+github pull request")`.

Do not guess tool names.
If `ToolSearch` returns nothing, the server failed to connect; report that rather than falling back to `gh`.

The server's own guidance on picking between its tools:

- `list_*` tools for broad retrieval and pagination of all items of a type, with basic filtering.
- `search_*` tools for targeted queries with keywords or complex filters.

## Conventions

Every operation below names the intent.
Resolve the concrete tool via `ToolSearch`.

- **Create an issue**: the issue-creation tool, with title and body. Pass the full body in one call rather than creating then editing.
- **Read an issue**: the issue-read tool, requesting comments and labels.
- **List issues**: the issue-list tool, filtered by state and label.
- **Comment on an issue**: the issue-comment tool.
- **Apply / remove labels**: the issue-update tool, or a dedicated label tool if the server exposes one.
- **Close**: the issue-update tool, setting state to closed, with a closing comment posted separately.

The repo (`seahsky/cadence-agent`) is passed explicitly as owner/repo arguments.
MCP tools do not infer it from the working directory the way `gh` did.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the server's pull-request tools:

- **Read a PR**: the PR-read tool, plus the PR-diff tool for the diff.
- **List external PRs for triage**: the PR-list tool, then keep only authors whose association is `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`). If the list tool doesn't return author association, fetch it per PR.
- **Comment / label / close**: the PR-comment and PR-update tools.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — try the PR-read tool first and fall back to the issue-read tool.

## When a skill says "publish to the issue tracker"

Create a GitHub issue via the MCP server.

## When a skill says "fetch the relevant ticket"

Read the issue via the MCP server, including its comments.

## Wayfinding operations

Used by `/wayfinder`.
The **map** is a single issue with **child** issues as tickets.

The upstream skill template drives sub-issues and issue dependencies through raw `gh api` REST calls.
Those raw endpoints have no `gh` fallback here, and the MCP server is not known to expose equivalents.
**Use the body-text conventions below**, which the upstream template already documents as its fallback.
If the MCP server turns out to expose sub-issue or dependency tools, prefer them and update this section.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: an issue with `Part of #<map>` at the top of its body, and an entry in a task list in the map body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every issue it lists is closed.
- **Frontier query**: list the map's open children from its task list, drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: assign the issue to the current user — the session's first write.
- **Resolve**: comment the answer on the issue, close it, then append a context pointer (gist + link) to the map's Decisions-so-far.
