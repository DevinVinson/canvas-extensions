import helperSource from "../plugin/scripts/artifact_store.py?raw";
import type { AgentRequest, Artifact, CanvasHost, Plugin, StoreResult } from "./types";

export const APP_SUBPATH = ".openhands/apps/artifact-handoff";
const TAG = "ARTIFACT_HANDOFF";
const maxMessage = 500;
const b64 = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));
const decode = (value: string) => new TextDecoder().decode(Uint8Array.from(atob(value), byte => byte.charCodeAt(0)));

function envelope(stdout: unknown): StoreResult<unknown> {
  const line = String(stdout ?? "").split(/\r?\n/).find(value => value.startsWith(`${TAG}\t`));
  if (!line) throw new Error("The Artifact Handoff helper returned no structured result.");
  try { return JSON.parse(decode(line.slice(TAG.length + 1))) as StoreResult<unknown>; } catch { throw new Error("The Artifact Handoff helper returned malformed structured data."); }
}

export function homeFrom(value: unknown): string {
  const home = typeof value === "string" ? value : (value as { home?: unknown })?.home;
  if (typeof home !== "string" || !/^\//.test(home) || home.includes("\0")) throw new Error("The Agent Server did not return a safe absolute home path.");
  return home.replace(/\/+$/, "");
}

export async function requestStore<T>(host: CanvasHost, request: Record<string, unknown>): Promise<T> {
  if (!host.agentServer) throw new Error("This Canvas host does not expose an Agent Server API.");
  const home = homeFrom(await host.agentServer.request({ path: "/api/file/home" }));
  const source = b64(helperSource); const payload = b64(JSON.stringify(request));
  // Both dynamic values are base64; no user controlled content becomes shell syntax.
  const command = `printf '%s' '${source}' | (base64 --decode 2>/dev/null || base64 -D) | python3 - '${payload}'`;
  const response = await host.agentServer.request<{ exit_code?: unknown; stdout?: unknown; stderr?: unknown }>({ path: "/api/bash/execute_bash_command", method: "POST", body: { command, cwd: home } });
  const result = envelope(response.stdout);
  if (!result.ok) throw new Error(result.error || "Artifact store command failed.");
  return result.data as T;
}

export async function installedPlugins(host: CanvasHost): Promise<{ state: "ok" | "unsupported"; plugins: Plugin[] }> {
  if (!host.agentServer) return { state: "unsupported", plugins: [] };
  try {
    const raw = await host.agentServer.request<unknown>({ path: "/api/plugins/installed" });
    const list = Array.isArray(raw) ? raw : (raw as { plugins?: unknown })?.plugins;
    if (!Array.isArray(list)) throw new Error("malformed plugin response");
    const plugins = list.filter((entry): entry is Plugin => Boolean(entry) && typeof (entry as Plugin).name === "string" && typeof (entry as Plugin).source === "string" && typeof (entry as Plugin).enabled === "boolean");
    return { state: "ok", plugins };
  } catch { return { state: "unsupported", plugins: [] }; }
}

export function matchingPlugin(plugins: Plugin[]): Plugin | undefined { return plugins.find(plugin => plugin.name === "artifact-handoff"); }
export function absoluteStorePath(home: string, artifact: Artifact): string { return `${home}/${APP_SUBPATH}/artifacts/${artifact.id}${artifact.content ? `/${artifact.content.path}` : "/manifest.json"}`; }

export function launchPath(plugin: Plugin, artifact: Artifact, home: string, objective: string): string {
  if (!plugin.source || (plugin.resolved_ref != null && typeof plugin.resolved_ref !== "string") || (plugin.repo_path != null && typeof plugin.repo_path !== "string")) throw new Error("Installed Plugin coordinates are malformed.");
  const path = absoluteStorePath(home, artifact);
  const cleanObjective = objective.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const message = `Inspect Artifact Handoff artifact ${artifact.id} at ${path} before acting.${cleanObjective ? ` Objective: ${cleanObjective}` : ""}`.slice(0, maxMessage);
  const coordinates = [{ source: plugin.source, ref: plugin.resolved_ref ?? null, repo_path: plugin.repo_path ?? null }];
  return `/launch?plugins=${encodeURIComponent(b64(JSON.stringify(coordinates)))}&message=${encodeURIComponent(message)}`;
}

export const __testing = { b64, decode, envelope, maxMessage };
