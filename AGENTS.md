# Canvas Apps contributor guide

This repository is a collection of installable Agent Canvas **Apps**. The
current host's technical API still uses `canvas-extension.json`,
`extension.js`, and `/extensions/<app>/<page>` routes; use **App** in
user-facing copy unless referring to that concrete API.

## Scope and structure

- Each App is a self-contained top-level directory with its own manifest,
  source, build configuration, tests, README, and checked-in `extension.js`.
- Do not introduce a shared runtime package, monorepo workspace, or common
  build foundation. Every App is intentionally an independent proof of what an
  App author can build.
- Do not move or rewrite existing Apps as part of a new App issue. In
  particular, `kanban-manager` is outside this roadmap.
- Keep mutable data outside the installed App directory. Browser-local data is
  scoped by App name and backend; backend-local data belongs under a clearly
  named `.openhands/apps/<app-name>/` directory discovered from the active
  Agent Server's home path.

## Current App contract

The active Canvas host loads one authenticated, self-contained browser ESM
bundle and calls its exported `activate(host)` function. Apps must:

- declare pages in `canvas-extension.json` and register only those pages;
- bundle all runtime dependencies, CSS, Workers, WASM, and required assets into
  `extension.js` with no bare imports, external chunks, or sibling assets;
- handle nested routes through the mount context `path` and `navigate`;
- return cleanup for event listeners, timers, requests, Workers, and mounted
  DOM; and
- work when the bundle is imported from a Blob URL, not merely a Vite preview.

`host.agentServer.request()` can call existing authenticated Agent Server HTTP
endpoints. This roadmap must not require a change in the OpenHands repository.

## Prerequisite onboarding

An App may require a CLI, database, binary, or other backend dependency. Its
first-run UI must probe without mutating state, explain what will be installed
and where, and offer a deliberate install/recheck flow plus a copyable prompt
that lets a user ask an OpenHands agent to perform setup.

Never interpolate user-controlled text into a shell command. Prefer fixed
command templates and structured/base64 input. Do not expose a general-purpose
terminal in an example App. Document commands, persistent files, downloads,
checksums, and any background process in the App README and onboarding UI.

## Required verification

Every App issue should leave behind:

- unit tests for activation, routing, error states, and cleanup;
- a build check proving exactly one self-contained `extension.js` output;
- a Blob-runtime smoke test; and
- a local Canvas acceptance checklist: build, install from the App's absolute
  local path, enable, exercise its primary flow, reload, disable, and re-enable.

The current Apps UI has no refresh control. During local development, rebuild
then uninstall and reinstall the App before retesting a changed bundle.

## Roadmap order

Issues are intentionally ordered from pure browser packaging through browser
WASM and persistence, backend CLI/database integration, native sidecars, and
finally a compound App + Plugin. Complete and validate each issue before
starting the next one; later Apps may copy proven patterns but must own their
implementation.
