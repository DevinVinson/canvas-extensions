---
name: prototype
description: Create and register a focused, portable self-contained HTML product prototype. Use when the user asks for a prototype, UI mockup, or interactive product concept.
triggers:
- /prototype
- product prototype
- html prototype
---

# /prototype

Create one self-contained HTML/CSS/JS file: do not require remote assets. Verify it exists and run the best available syntax or browser check. Inspect it for credentials before storage. Then call `plugin/scripts/artifact_store.py` through a base64 JSON `register` request with `type` and `originating_skill` set to `prototype`, `storage_mode: snapshot`, a `text/html` media type, tags, a concise summary, and `html_entrypoint: true`. Do not interpolate user text into shell source. Report the artifact id, stored path, and verification status. The Canvas App deliberately previews this snapshot in a sandbox with scripts disabled.
