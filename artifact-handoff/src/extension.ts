import styles from "./styles.css?inline";
import {
  absoluteStorePath,
  installedPlugins,
  launchPath,
  matchingPlugin,
  requestStore,
} from "./store";
import type { Artifact, CanvasHost, Mount, Plugin } from "./types";

const page = "artifacts";
export const ARTIFACTS_ROUTE = "/extensions/artifact-handoff/artifacts";
const text = (tag: string, value = "", className = "") => {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
};
const button = (value: string, action: () => void) => {
  const node = text("button", value) as HTMLButtonElement;
  node.type = "button";
  node.addEventListener("click", action);
  return node;
};

class ArtifactsApp {
  private root = document.createElement("main");
  private abort = new AbortController();
  private home = "";
  private plugin: Plugin | undefined;
  private artifacts: Artifact[] = [];
  constructor(
    private host: CanvasHost,
    private mount: Mount,
  ) {
    this.root.className = "artifact-handoff";
  }
  start() {
    this.mount.container.append(this.root);
    const path = this.mount.path
      .replace(/^\/+|\/+$/g, "")
      .replace(/^artifacts\//, "");
    if (!path || path === "artifacts") void this.reload();
    else if (/^[a-z0-9][a-z0-9-]{7,79}$/.test(path)) void this.detail(path);
    else this.onboarding("This nested artifact route is invalid.");
    return () => {
      this.abort.abort();
      this.root.replaceChildren();
      this.root.remove();
    };
  }
  private reset(title: string) {
    this.root.replaceChildren(
      text("header", "ARTIFACT HANDOFF", "eyebrow"),
      text("h1", title),
      text(
        "p",
        "A small, durable library for work an agent should be able to pick up later.",
        "lede",
      ),
    );
  }
  private async reload() {
    this.reset("Artifacts");
    this.root.append(
      text("p", "Checking the local store and companion Plugin…", "status"),
    );
    try {
      if (!this.host.agentServer || this.host.backend?.kind === "cloud")
        return this.onboarding(
          "This App needs a local Agent Server; cloud backends do not expose this durable store.",
        );
      const rawHome = await this.host.agentServer.request({
        path: "/api/file/home",
      });
      this.home =
        typeof rawHome === "string"
          ? rawHome
          : String((rawHome as { home?: unknown }).home ?? "");
      if (!/^\//.test(this.home))
        throw new Error("Agent Server home is unavailable.");
      const [probe, pluginStatus] = await Promise.all([
        requestStore<{ python: string; store_exists: boolean; root: string }>(
          this.host,
          { action: "probe" },
        ),
        installedPlugins(this.host),
      ]);
      this.plugin = matchingPlugin(pluginStatus.plugins);
      if (pluginStatus.state === "unsupported")
        return this.onboarding(
          "The Plugin management API is unavailable on this host. The artifact store can still be inspected when Python is available.",
        );
      if (!this.plugin)
        return this.onboarding(
          `The Artifact Handoff Plugin is not installed. The store probe was non-mutating (${probe.root}).`,
        );
      if (!this.plugin.enabled)
        return this.onboarding(
          "The Artifact Handoff Plugin is installed but disabled. Enable it separately, then begin a fresh conversation so its skills load.",
        );
      const listed = await requestStore<{
        artifacts: Artifact[];
        invalid: { directory: string; error: string }[];
        truncated: boolean;
      }>(this.host, { action: "list" });
      this.artifacts = listed.artifacts;
      this.library(listed.invalid, listed.truncated);
    } catch (error) {
      this.onboarding(
        error instanceof Error ? error.message : "The store probe failed.",
      );
    }
  }
  private onboarding(reason: string) {
    this.reset("Ready when you are");
    this.root.append(text("p", reason, "warning"));
    const details = text("section", "", "card");
    details.append(
      text("h2", "Two deliberate trust actions"),
      text(
        "p",
        "Install this Canvas App and the companion OpenHands Plugin separately. Both begin disabled; this App never installs or enables the Plugin.",
      ),
      text("code", "artifact-handoff/plugin"),
      text(
        "p",
        "Ask an OpenHands agent: Install the local Artifact Handoff Plugin from artifact-handoff/plugin, leave it disabled, then tell me how to enable it. Do not install packages or enable it automatically.",
      ),
    );
    this.root.append(
      details,
      button("Recheck readiness", () => void this.reload()),
    );
  }
  private library(
    invalid: { directory: string; error: string }[],
    truncated: boolean,
  ) {
    this.reset("Artifacts");
    const controls = document.createElement("div");
    controls.className = "controls";
    const query = document.createElement("input");
    query.placeholder = "Search title, summary, or tag";
    query.setAttribute("aria-label", "Search artifacts");
    const type = document.createElement("select");
    type.setAttribute("aria-label", "Filter artifact type");
    type.append(
      new Option("All types", ""),
      ...[...new Set(this.artifacts.map((item) => item.type))]
        .sort()
        .map((value) => new Option(value, value)),
    );
    const skill = document.createElement("select");
    skill.setAttribute("aria-label", "Filter originating skill");
    skill.append(
      new Option("All skills", ""),
      ...[...new Set(this.artifacts.map((item) => item.originating_skill))]
        .sort()
        .map((value) => new Option(value, value)),
    );
    const mode = document.createElement("select");
    mode.setAttribute("aria-label", "Filter storage mode");
    mode.append(
      new Option("All storage", ""),
      new Option("snapshot", "snapshot"),
      new Option("reference", "reference"),
    );
    const list = document.createElement("section");
    list.className = "library";
    const render = () => {
      list.replaceChildren();
      const needle = query.value.toLowerCase().trim();
      const matches = this.artifacts.filter(
        (item) =>
          (!needle ||
            [item.title, item.summary, ...item.tags]
              .join(" ")
              .toLowerCase()
              .includes(needle)) &&
          (!type.value || item.type === type.value) &&
          (!skill.value || item.originating_skill === skill.value) &&
          (!mode.value || item.storage_mode === mode.value),
      );
      if (!matches.length)
        list.append(text("p", "No artifacts match this view.", "empty"));
      for (const item of matches) {
        const card = text("article", "", "artifact-card");
        card.append(
          text("span", `${item.type} · ${item.storage_mode}`, "badge"),
          text("h2", item.title),
          text("p", item.summary),
          text("small", `${item.originating_skill} · ${item.created_at}`),
          button("Open artifact", () =>
            this.mount.navigate(`${ARTIFACTS_ROUTE}/${item.id}`),
          ),
        );
        list.append(card);
      }
    };
    query.addEventListener("input", render, { signal: this.abort.signal });
    for (const control of [type, skill, mode])
      control.addEventListener("change", render, { signal: this.abort.signal });
    controls.append(
      query,
      type,
      skill,
      mode,
      button("Reload", () => void this.reload()),
    );
    this.root.append(controls);
    if (invalid.length)
      this.root.append(
        text(
          "p",
          `${invalid.length} invalid artifact manifest(s) were skipped without hiding valid artifacts.`,
          "warning",
        ),
      );
    if (truncated)
      this.root.append(text("p", "List capped at 200 artifacts.", "warning"));
    this.root.append(list);
    render();
  }
  private async detail(id: string) {
    this.reset("Artifact detail");
    this.root.append(
      text("p", "Loading validated artifact metadata…", "status"),
    );
    try {
      const result = await requestStore<{
        manifest: Artifact;
        preview?: string;
        preview_truncated?: boolean;
        reference_exists?: boolean;
        verification?: string;
      }>(this.host, { action: "get", id, preview: true });
      const artifact = result.manifest;
      this.reset(artifact.title);
      this.root.append(text("p", artifact.summary, "lede"));
      const meta = text("section", "", "card");
      meta.append(
        text("p", `ID: ${artifact.id}`),
        text(
          "p",
          `Origin: ${artifact.originating_skill} · ${artifact.producer}`,
        ),
        text("p", `Mode: ${artifact.storage_mode}`),
        text("p", `Source: ${artifact.source}`),
        text("p", `Stored path: ${absoluteStorePath(this.home, artifact)}`),
      );
      if (result.reference_exists === false)
        meta.append(
          text(
            "p",
            "Local reference is stale; it was never read automatically.",
            "warning",
          ),
        );
      this.root.append(meta);
      if (artifact.content && result.preview !== undefined) {
        if (
          artifact.html_entrypoint &&
          artifact.content.media_type === "text/html"
        ) {
          const frame = document.createElement("iframe");
          frame.sandbox.value = "";
          frame.title = "Static prototype preview; scripts disabled";
          frame.srcdoc = result.preview;
          frame.className = "preview-frame";
          this.root.append(
            text(
              "p",
              "Static prototype preview — interactive scripts are disabled.",
              "warning",
            ),
            frame,
          );
        } else {
          const pre = text("pre", result.preview, "preview");
          this.root.append(pre);
          if (result.preview_truncated)
            this.root.append(
              text("p", "Preview truncated at 64 KiB.", "warning"),
            );
        }
      }
      const reuse = text("section", "", "reuse card");
      reuse.append(text("h2", "Reuse this artifact"));
      const objective = document.createElement("input");
      objective.maxLength = 250;
      objective.placeholder = "Short objective for the new conversation";
      objective.setAttribute("aria-label", "Reuse objective");
      reuse.append(
        objective,
        button("Start conversation with artifact", () => {
          if (!this.plugin)
            return this.onboarding(
              "Install and enable the companion Plugin before reuse.",
            );
          this.mount.navigate(
            launchPath(this.plugin, artifact, this.home, objective.value),
          );
        }),
      );
      this.root.append(
        reuse,
        button("Back to library", () => this.mount.navigate(ARTIFACTS_ROUTE)),
      );
    } catch (error) {
      this.onboarding(
        error instanceof Error ? error.message : "Unable to load artifact.",
      );
    }
  }
}

export function activate(host: CanvasHost): () => void {
  if (host.apiVersion !== "1")
    throw new Error(
      `Artifact Handoff requires Canvas host API 1, received ${host.apiVersion}.`,
    );
  const unregister = host.registerPage(page, (mount) =>
    new ArtifactsApp(host, mount).start(),
  );
  return () => unregister();
}
export const __testing = { page };
