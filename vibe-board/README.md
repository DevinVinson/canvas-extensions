# Vibe

Vibe is a kanban board for agent work. You queue requests as cards, a manager
agent picks them up and dispatches workers, and the board shows what each agent
is doing right now and what has landed.

It is a Canvas Extension with no server of its own. Everything it needs — the
board, its settings, ticket attachments — is JSON on the Agent Server's own
filesystem, written through the file API.

## Lanes

Cards move left to right: **Pending** → **In progress** → **Needs input** →
**Finished**, plus a **Verified** lane you can toggle for the archive. Drag a
card to reprioritise within a lane. Click one to open a drawer with the full
append-only history; adding a note to a finished ticket reopens it.

In-progress cards show the worker's most recent action as it happens, so you
can see an agent working without opening its conversation.

## How it stores state

There is no database and no backend process. The store is a directory tree
under the Agent Server's home:

```
~/.openhands/vibe-manager/
  index.json                     workspaces + settings
  workspaces/<id>/board.json     one board per workspace
  attachments/<id>/<filename>    uploaded files
```

Reads are `GET /api/file/download`, writes are `POST /api/file/upload`, both
through the host's `agentServer.request` so they are same-origin and
authenticated by Canvas. The home directory is resolved at runtime from
`GET /api/file/home` rather than assumed, so this works whatever user the
Agent Server runs as.

Two consequences worth knowing:

- **The board is single-user.** Every write is a read-modify-write of one JSON
  file with no locking. That is fine for one person driving one Canvas, and not
  fine for concurrent writers.
- **Reads bypass the HTTP cache.** The file API sends `ETag`/`Last-Modified`
  but no `Cache-Control`, so a browser may reuse a stale board for its
  heuristic freshness window. Because writes are read-modify-write, a stale
  read does not just show old data, it destroys the ticket created just before
  it. `readJson` defeats this per request; attachment blobs are immutable and
  stay cacheable.

## Dispatching agents

The board is the UI half of a pair. Cards only start moving on their own if a
manager automation is polling the same store and dispatching workers — that
half lives in [rbren/vibe-manager](https://github.com/rbren/vibe-manager) as a
cron automation. Without it the board is a perfectly good manual kanban: you
can still create, edit, reorder, and verify tickets, and open the conversation
behind any card.

## Build

The checked-in `extension.js` is the built bundle; the sources are in `src/`.

```bash
npm install
npm run check     # build + test
```

`build.mjs` bundles the ES modules with esbuild and inlines `src/board.css`,
scoping every selector under `.vibe-ext` and rewriting `rem` lengths onto a
local `--vibe-rem` so the board can size itself without restyling Canvas.

## Tests

`src/extension.test.js` mounts the built bundle against a linkedom DOM and a
fake host, and covers rendering, lane sorting, the submit path, and disposal.
It runs on the bundle rather than the sources, so a broken build fails the
suite.

The upstream repository additionally has tests that drive the real Agent Server
file API; those need a running server and are not included here.
