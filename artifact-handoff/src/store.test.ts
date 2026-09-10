import { describe, expect, it } from "vitest";
import { launchPath, matchingPlugin } from "./store";
import type { Artifact } from "./types";
const artifact: Artifact = { schema_version: 1, id: "ah-12345678", title: "Safe", summary: "Summary", type: "handoff", tags: [], created_at: "2026-01-01T00:00:00Z", producer: "test", originating_skill: "handoff", storage_mode: "snapshot", source: "/tmp/a.md", content: { path: "content/a.md", media_type: "text/markdown", bytes: 1, sha256: "0".repeat(64) } };
describe("launch route", () => {
  it("uses installed, pinned coordinates and a bounded path message", () => { const path = launchPath({ name: "artifact-handoff", enabled: true, source: "local", resolved_ref: "abc", repo_path: "artifact-handoff/plugin" }, artifact, "/srv/home", "x".repeat(900)); expect(path).toContain("/launch?plugins="); const params = new URLSearchParams(path.split("?", 2)[1]); expect(atob(params.get("plugins")!)).toContain("artifact-handoff/plugin"); expect(params.get("message")!.length).toBeLessThanOrEqual(500); });
  it("does not mistake a different plugin for the companion", () => expect(matchingPlugin([{ name: "other", enabled: true, source: "local" }])).toBeUndefined());
});
