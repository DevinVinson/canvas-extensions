---
name: save-artifact
description: Register an existing durable SDLC output as a bounded snapshot or a non-copying reference. Use when the user asks to save, register, catalog, or hand off a plan, PRD, report, specification, ADR, or test result.
triggers:
  - /save-artifact
  - save artifact
  - register artifact
---

# /save-artifact

Ask only for metadata that materially changes storage: title, summary, type, tags, and whether to make a snapshot or reference. Do not rebuild, reinterpret, or run arbitrary content. Use `plugin/scripts/artifact_store.py` and pass one structured base64 JSON request. Snapshots accept only one regular non-symlink file up to 4 MiB; references record a source path or URL and are never automatically read by the App. Inspect likely secrets and tell the user if the artifact may contain sensitive material. Return the artifact id and stored path.

This is the interoperability seam: bundled `/handoff` and `/prototype` register themselves, but arbitrary unmodified third-party skills are not globally intercepted.
