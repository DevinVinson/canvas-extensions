---
name: handoff
description: Create and register a compact, durable continuation handoff for a later OpenHands conversation. Use when the user asks for a handoff, continuation notes, or a summary for the next agent.
triggers:
- /handoff
- handoff
- continuation notes
---

# /handoff

Write a concise Markdown continuation document in a safe workspace temporary file. Include accomplishments, decisions, current workspace state, important context, commands/actions, referenced specs/issues/commits, suggested skills, next steps, open questions, a continuation prompt, and notes for the next agent. Link to existing durable material rather than duplicating it. Redact credentials, tokens, and unnecessary personal data.

Before replying, invoke `plugin/scripts/artifact_store.py` with a base64 JSON `register` request: `type` and `originating_skill` are `handoff`, `storage_mode` is `snapshot`, and the source is that Markdown file. The helper writes only under the active Agent Server home’s `.openhands/apps/artifact-handoff/`. Never interpolate metadata or paths into shell source; pass one encoded request. Report the durable artifact id and stored path. If registration fails, clearly report a partial failure rather than claiming success.
