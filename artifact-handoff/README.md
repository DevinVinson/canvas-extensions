# Artifact Handoff App + Plugin

Artifact Handoff is an independent Canvas App plus an independent OpenHands Plugin. It stores durable handoffs, portable prototypes, plans, reports, and similar SDLC outputs in a small inspectable store, then lets a person start a new Plugin-enabled conversation from an artifact path. It does not modify OpenHands and does not globally intercept arbitrary third-party skills.

## Install locally

Install the Canvas App from this repository’s absolute path:

```text
/Users/devinvinson/.codex/worktrees/4e7d/canvas-extensions/artifact-handoff
```

Install the OpenHands Plugin separately from:

```text
/Users/devinvinson/.codex/worktrees/4e7d/canvas-extensions/artifact-handoff/plugin
```

Both are separate trust actions and initially disabled. The App calls `GET /api/plugins/installed` for readiness; it never installs or enables the Plugin. Start a fresh conversation after enabling the Plugin to load `/handoff`, `/prototype`, and `/save-artifact`.

## Storage and safety

The App discovers the active Agent Server home using `GET /api/file/home`; mutable data is only below:

```text
<home>/.openhands/apps/artifact-handoff/artifacts/<artifact-id>/
  manifest.json
  content/<safe-filename>  # snapshot mode only
```

The Python standard-library helper at `plugin/scripts/artifact_store.py` is the single implementation used by both the App (embedded into the Blob bundle) and Plugin. It uses a versioned v1 manifest, collision-resistant IDs, temporary sibling directories, `manifest.json` last, and an atomic rename. It rejects symlinks, traversal, non-regular snapshots, unsafe names, oversized snapshots (4 MiB), malformed manifests, and checksum mismatches. Lists cap at 200 entries and previews cap at 64 KiB. Snapshots are one file only; references are metadata only and the App merely reports whether a local reference still exists. It never reads a reference path.

The UI treats manifests and contents as untrusted: text uses safe DOM text APIs and HTML prototypes use a sandboxed iframe with scripts disabled. Do not intentionally store secrets; the bundled skills require a sensitive-content review.

`/handoff` and `/prototype` automatically register their own outputs. `/save-artifact` and the documented helper request are the seam for other workflows. Unmodified third-party skills are not globally captured.

## Reuse

The detail page uses the detected Plugin `source`, `resolved_ref`, and `repo_path` to construct Canvas `/launch?plugins=...`, with a path-based message capped at 500 characters. Canvas supplies the normal trust/create confirmation. The App never posts a handcrafted conversation payload or includes the full artifact in a URL.

## Development and verification

```bash
cd artifact-handoff
npm ci
npm run check
```

`check` typechecks, builds exactly one self-contained checked-in `extension.js`, runs TypeScript and Python store tests, and imports the final bundle from a Blob in Chromium.

## Local Canvas acceptance checklist

1. Build, install the App from the absolute path above, and enable it.
2. Confirm its first probe creates no `.openhands/apps/artifact-handoff` directory and Plugin-missing guidance is shown.
3. Install `plugin/`, leave it disabled, reload, and verify installed-disabled guidance.
4. Enable the Plugin, start a fresh conversation, then run `/handoff`; reload Artifacts and inspect the Markdown snapshot.
5. Run `/prototype`; confirm its self-contained HTML appears in the isolated script-disabled preview.
6. Run `/save-artifact` on another document in snapshot and reference modes; move the referenced source and confirm it becomes stale without being read.
7. Enter a short reuse objective; select **Start conversation with artifact** and confirm Canvas displays the normal Plugin launch confirmation before creating the conversation.
8. Reload; disable/re-enable the App and Plugin; rebuild then uninstall/reinstall the App before retesting a changed bundle (Canvas has no refresh control).
