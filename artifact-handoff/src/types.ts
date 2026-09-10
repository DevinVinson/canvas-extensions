export interface AgentRequest { path: string; method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string> }
export interface CanvasHost { apiVersion: string; backend?: { kind?: string | null }; agentServer?: { request<T = unknown>(request: AgentRequest): Promise<T> }; registerPage(id: string, mount: (context: Mount) => void | (() => void)): () => void }
export interface Mount { container: HTMLElement; path: string; navigate(path: string): void }
export interface Plugin { name: string; enabled: boolean; source: string; resolved_ref?: string | null; repo_path?: string | null }
export interface Content { path: string; media_type: string; bytes: number; sha256: string }
export interface Artifact { schema_version: 1; id: string; title: string; summary: string; type: string; tags: string[]; created_at: string; producer: string; originating_skill: string; workspace_path?: string | null; conversation_id?: string | null; storage_mode: "snapshot" | "reference"; source: string; content?: Content; html_entrypoint?: { path: string; scripts_disabled: boolean } }
export interface StoreResult<T> { ok: boolean; data?: T; error?: string }
