# Artifact Handoff manifest schema v1

Each completed artifact directory contains `manifest.json`, written last and atomically renamed into `<agent-server-home>/.openhands/apps/artifact-handoff/artifacts/<opaque-id>/`.

Required fields are `schema_version: 1`, opaque `id`, `title`, `summary`, `type`, `tags`, `created_at`, `producer`, `originating_skill`, `storage_mode`, and `source`. Types are `handoff`, `prototype`, `plan`, `spec`, `report`, `test-report`, or `other`. The originating skill is `handoff`, `prototype`, or `save-artifact`. Unknown additive fields are ignored.

A `snapshot` has `content.path` (`content/<safe-name>`), `media_type`, `bytes` (at most 4 MiB), and a SHA-256. It is exactly one regular file, never a symlink. A prototype may add `html_entrypoint`; the Canvas App disables scripts while previewing it. A `reference` has no copied content and records its source path or URL. The App only checks whether a local reference still exists; it does not open it.
