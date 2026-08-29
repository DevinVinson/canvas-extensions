# Kanban Manager

Kanban Manager is a board for agent work. You queue requests as cards, a
manager agent picks them up and dispatches workers, and the board shows what
each agent is doing right now and what has landed.

It is a Canvas Extension with no server of its own. Everything it needs — the
board, its settings, ticket attachments — is JSON on the Agent Server's own
filesystem, written through the file API.

(Previously published here as `vibe-board`.)

## Lanes

Cards move left to right: **Pending** → **In progress** → **Needs input** →
**Finished**, plus a **Verified** lane you can toggle for the archive. Drag a
card to reprioritise within a lane. Click one to open a drawer with the full
append-only history; adding a note to a finished ticket reopens it.

In-progress cards show the worker's most recent action as it happens, so you
can see an agent working without opening its conversation.

## The manager

The control in the top right owns the manager automation for the selected
workspace, so a board can be made autonomous without leaving Canvas:

- **Start manager** (orange) — there is no manager yet, or it was stopped.
  Clicking it packs the automation's python sources (compiled into the bundle,
  `src/automation/`) plus a per-workspace `config.json` into a `tar.gz`,
  uploads it to `POST /api/automation/v1/uploads`, and creates a cron
  automation that runs `python3 main.py` once a minute. The automation id is
  recorded on the workspace.
- **manager ✓ / working / ✗** — a manager is running. The badge reports the
  last run and the manager conversation; clicking it triggers a run now.
- **Stop manager** — `PATCH {"enabled": false}`. The automation and its run
  history are kept, so starting again is a re-enable with a fresh tarball.

Two implementation notes, since neither is obvious:

- The tar archive is built in the browser and gzipped with
  `CompressionStream`. Sizes in the ustar header must be **byte** counts, not
  string lengths, or a file with any multi-byte character truncates and every
  following header lands mid-stream.
- The upload is a plain `fetch` rather than `host.agentServer.request`,
  because the host client JSON-stringifies any body that is not `FormData`,
  which would corrupt the gzip bytes. Every other call goes through the host.

Without a manager the board is still a perfectly good manual kanban: you can
create, edit, reorder and verify tickets, and open the conversation behind any
card.

## How it stores state

There is no database and no backend process. The store is a directory tree
under the Agent Server's home:

```
~/.openhands/vibe-manager/
  index.json                     workspaces + settings
  workspaces/<id>/board.json     one board per workspace
  attachments/<id>/<filename>    uploaded files
```

The directory keeps its old name so boards created by earlier installs — and
by the manager automation, which writes the same files from the shell — are
still found.

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

## Build

The checked-in `extension.js` is the built bundle; the sources are in `src/`.

```bash
npm install
npm run check     # build + test
```

`build.mjs` bundles the ES modules with esbuild and inlines two things that
must travel with a single-file extension:

- `src/board.css`, scoping every selector under `.vibe-ext` and rewriting
  `rem` lengths onto a local `--vibe-rem`, so the board can size itself
  without restyling Canvas;
- `src/automation/*.py`, the manager automation, because "Start manager"
  uploads it from the browser and the machine running Canvas has no checkout
  of it to read.

Both are vendored from [rbren/vibe-manager](https://github.com/rbren/vibe-manager),
which is where they are maintained. The bundle's destination comes from the
manifest's `entrypoint`, so the declared and built paths cannot drift.

## Tests

`test/extension.test.js` mounts the built bundle against a linkedom DOM and a
fake host, and covers rendering, lane sorting, the submit path, the manager
start/stop control and disposal. It runs on the bundle rather than the
sources, so a broken build fails the suite.

`test/manager.test.mjs` checks the browser-built tarball with real GNU tar. It
also has two tests that talk to a running automation backend; they skip unless
a session key is available (`OH_SESSION_API_KEYS_0`, plus `VIBE_TEST_INGRESS`
if it is not on `http://127.0.0.1:8000`).

The upstream repository additionally has tests that drive the real Agent Server
file API; those need a running server and are not included here.
