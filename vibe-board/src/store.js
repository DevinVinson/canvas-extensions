/* Board state on disk, reached through the agent-server file API.

   Replaces the vibe-manager FastAPI service. Every call goes through the
   Canvas host's `agentServer.request`, which targets the active backend and
   attaches the session key — so there is no base URL to configure, no
   credentials to manage, and no cross-origin request to be blocked.

   Layout is documented in store/SCHEMA.md: an index.json listing workspaces,
   and one board.json per workspace holding its tickets with entries and
   attachments embedded.

   Writes are read-modify-write of a whole board document. This is a
   single-user tool and the previous SQLite backend serialized these; see
   SCHEMA.md for why that trade is acceptable here. */

/* The store lives under the agent-server user's home. The file API needs
   absolute paths and does not expand "~", so the home directory is resolved
   once from GET /api/file/home rather than assuming /root — the agent server
   may run as any user, and in a sandbox it usually does. */
export const STORE_SUBPATH = ".openhands/vibe-manager";

export const STATUSES = ["pending", "in_progress", "needs_input", "finished"];
export const VERIFIED = "verified";

export function newId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function nowTs() {
  return Date.now() / 1000;
}

/* The file API keeps `filename` in a query param and writes it verbatim, so
   the same sanitizing the old service did has to happen here. */
export function safeFilename(name) {
  const base = String(name || "").replace(/\\/g, "/").split("/").pop().trim();
  const cleaned = base.replace(/[^A-Za-z0-9._ ()[\]-]+/g, "_").slice(0, 120)
    .replace(/^[._ ]+|[._ ]+$/g, "");
  return cleaned || "file";
}

/* Resolve the active backend's {host, apiKey} from the registry Canvas keeps
   in localStorage.

   Needed ONLY for binary downloads. `host.agentServer.request` parses an
   octet-stream body as text, which corrupts image bytes, and the host API
   exposes no responseType/blob option — so attachment previews have to issue
   their own fetch. This is the same registry Canvas's own automation client
   reads, but it is undocumented surface: if the host API ever grows a blob
   helper, delete this and use it. */
export function resolveBackendCredentials(backendId) {
  try {
    const raw = localStorage.getItem("openhands-backends");
    if (!raw) return null;
    const backends = JSON.parse(raw);
    if (!Array.isArray(backends)) return null;
    const match = backends.find((b) => b && b.id === backendId) || backends[0];
    if (!match || typeof match.host !== "string") return null;
    return { host: match.host.replace(/\/+$/, ""), apiKey: match.apiKey || "" };
  } catch {
    return null;
  }
}

export class Store {
  constructor(host, root = null) {
    this.host = host;
    this.root = root;
    this.rootPromise = null;
  }

  /** Absolute store root, resolved from the agent server's home dir once. */
  async storeRoot() {
    if (this.root) return this.root;
    if (!this.rootPromise) {
      this.rootPromise = this.host.agentServer
        .request({ path: "/api/file/home" })
        .then((res) => {
          const home = (typeof res === "string" ? JSON.parse(res) : res)?.home;
          if (!home) throw new Error("agent server did not report a home directory");
          this.root = `${home.replace(/\/+$/, "")}/${STORE_SUBPATH}`;
          return this.root;
        })
        .catch((err) => {
          // Allow a later call to retry instead of caching the failure.
          this.rootPromise = null;
          throw err;
        });
    }
    return this.rootPromise;
  }

  async indexPath() {
    return `${await this.storeRoot()}/index.json`;
  }

  async boardPath(wsId) {
    return `${await this.storeRoot()}/workspaces/${wsId}/board.json`;
  }

  async attachmentPath(attId, filename) {
    return `${await this.storeRoot()}/attachments/${attId}/${filename}`;
  }

  /** Binary-safe download. See resolveBackendCredentials for why this exists. */
  async fetchBlob(path, contentType) {
    const creds = resolveBackendCredentials(this.host?.backend?.id);
    if (!creds) throw new Error("no backend credentials available for binary download");
    const res = await fetch(
      `${creds.host}/api/file/download?path=${encodeURIComponent(path)}`,
      { headers: creds.apiKey ? { "X-Session-API-Key": creds.apiKey } : {} },
    );
    if (!res.ok) {
      const err = new Error(`${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    const blob = await res.blob();
    // The file API always says octet-stream; re-tag so <img> renders it.
    return contentType ? blob.slice(0, blob.size, contentType) : blob;
  }

  // ---------------------------------------------------------------- file API

  async readJson(path, fallback) {
    let raw;
    try {
      /* The file API sends ETag/Last-Modified but no Cache-Control, so the
         browser is free to reuse a stale board for its heuristic freshness
         window. That stalls the poll and, because every write is a
         read-modify-write, lets a stale read drop the previous ticket. Defeat
         it per read; attachments stay cacheable, they never change. */
      raw = await this.host.agentServer.request({
        path: `/api/file/download?path=${encodeURIComponent(path)}&_=${Date.now()}`,
        headers: { "Cache-Control": "no-cache" },
      });
    } catch (err) {
      // A missing document is an expected state (no workspaces onboarded yet,
      // freshly selected workspace); anything else is a real failure.
      if (fallback !== undefined && isNotFound(err)) return fallback;
      throw err;
    }
    // The file API serves every file as application/octet-stream, so the
    // Canvas client parses the body as text rather than JSON.
    if (typeof raw !== "string") return raw;
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`corrupt JSON at ${path}: ${err.message}`);
    }
  }

  async writeJson(path, payload) {
    await this.writeFile(path, new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    }), path.split("/").pop());
  }

  async writeFile(path, blob, filename) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    await this.host.agentServer.request({
      method: "POST",
      path: `/api/file/create_directory?path=${encodeURIComponent(dir)}`,
    });
    const form = new FormData();
    form.append("file", blob, filename);
    await this.host.agentServer.request({
      method: "POST",
      path: `/api/file/upload?path=${encodeURIComponent(path)}`,
      body: form,
    });
  }

  // -------------------------------------------------------------- workspaces

  async readIndex() {
    const idx = await this.readJson(await this.indexPath(), { version: 1, workspaces: [] });
    return idx && Array.isArray(idx.workspaces) ? idx : { version: 1, workspaces: [] };
  }

  async writeIndex(index) {
    await this.writeJson(await this.indexPath(), { ...index, version: 1 });
  }

  /** Selected workspaces plus the candidates the agent server knows about. */
  async listWorkspaces() {
    const index = await this.readIndex();
    const selected = index.workspaces;
    const seen = new Set(selected.map((w) => w.path));

    let available = [];
    try {
      const data = await this.host.agentServer.request({ path: "/api/workspaces" });
      const parents = data?.workspaceParents || [];
      const entries = await Promise.all(
        parents.map(async (parent) => {
          try {
            const res = await this.host.agentServer.request({
              path: `/api/file/search_subdirs?path=${encodeURIComponent(parent.path)}`,
            });
            return res?.items || [];
          } catch {
            return [];
          }
        }),
      );
      available = entries
        .flat()
        .filter((item) => item.name && !item.name.startsWith(".") && !item.name.startsWith("_"))
        .map((item) => ({ path: item.path, name: item.name }));
    } catch {
      // Without the agent server we can still show what is already onboarded.
      available = [];
    }

    const merged = [...available.filter((a) => !seen.has(a.path))];
    return { available: merged, selected };
  }

  async selectWorkspace(path) {
    const index = await this.readIndex();
    const existing = index.workspaces.find((w) => w.path === path);
    if (existing) return existing;

    const ws = {
      id: newId(),
      path,
      name: path.split("/").filter(Boolean).pop() || path,
      max_concurrent: 2,
      push_mode: "main",
      automation_id: null,
      manager_conversation_id: null,
      created_at: nowTs(),
    };
    index.workspaces.push(ws);
    await this.writeIndex(index);
    await this.writeBoard(ws.id, { version: 1, workspace_id: ws.id, tickets: [] });
    return ws;
  }

  async updateWorkspace(wsId, patch) {
    const index = await this.readIndex();
    const ws = index.workspaces.find((w) => w.id === wsId);
    if (!ws) throw new Error("workspace not found");
    Object.assign(ws, patch);
    await this.writeIndex(index);
    return ws;
  }

  // ------------------------------------------------------------------ boards

  async readBoard(wsId) {
    const board = await this.readJson(await this.boardPath(wsId), null);
    if (!board) return { version: 1, workspace_id: wsId, tickets: [] };
    return { ...board, tickets: board.tickets || [] };
  }

  async writeBoard(wsId, board) {
    await this.writeJson(await this.boardPath(wsId), {
      ...board, version: 1, workspace_id: wsId,
    });
  }

  /** Read, apply `mutate`, write back. Returns whatever `mutate` returns. */
  async mutateBoard(wsId, mutate) {
    const board = await this.readBoard(wsId);
    const result = mutate(board);
    await this.writeBoard(wsId, board);
    return result;
  }

  async getBoard(wsId) {
    const [index, board] = await Promise.all([this.readIndex(), this.readBoard(wsId)]);
    const workspace = index.workspaces.find((w) => w.id === wsId) || null;
    return { workspace, tickets: board.tickets };
  }

  // ----------------------------------------------------------------- tickets

  async createTicket(wsId, body) {
    const text = (body || "").trim();
    if (!text) throw new Error("empty ticket body");
    const now = nowTs();
    return this.mutateBoard(wsId, (board) => {
      const maxOrder = board.tickets
        .filter((t) => t.status === "pending")
        .reduce((max, t) => Math.max(max, t.sort_order || 0), 0);
      const ticket = {
        id: newId(),
        status: "pending",
        title: null,
        sort_order: maxOrder + 1,
        conversation_id: null,
        pr_url: null,
        manager_note: null,
        dispatched_entry_count: 0,
        created_at: now,
        updated_at: now,
        finished_at: null,
        verified_at: null,
        entries: [{ id: newId(), author: "user", body: text, created_at: now }],
        attachments: [],
      };
      board.tickets.push(ticket);
      return ticket;
    });
  }

  async appendEntry(wsId, ticketId, body, author = "user") {
    const text = (body || "").trim();
    if (!text) throw new Error("empty entry body");
    const now = nowTs();
    return this.mutateBoard(wsId, (board) => {
      const ticket = board.tickets.find((t) => t.id === ticketId);
      if (!ticket) throw new Error("ticket not found");
      ticket.entries.push({ id: newId(), author, body: text, created_at: now });
      ticket.updated_at = now;
      // A new user request reopens a finished/needs_input ticket immediately
      // (bottom of pending) instead of waiting for the manager cycle.
      // in_progress is left alone (a worker is running); verified is terminal.
      if (author === "user" && (ticket.status === "finished" || ticket.status === "needs_input")) {
        const maxOrder = board.tickets
          .filter((t) => t.status === "pending")
          .reduce((max, t) => Math.max(max, t.sort_order || 0), 0);
        ticket.status = "pending";
        ticket.sort_order = maxOrder + 1;
      }
      return ticket;
    });
  }

  async verifyTicket(wsId, ticketId) {
    const now = nowTs();
    return this.mutateBoard(wsId, (board) => {
      const ticket = board.tickets.find((t) => t.id === ticketId);
      if (!ticket) throw new Error("ticket not found");
      ticket.status = VERIFIED;
      ticket.verified_at = now;
      ticket.updated_at = now;
      return ticket;
    });
  }

  async reorder(wsId, status, orderedIds) {
    if (!STATUSES.includes(status)) throw new Error("bad status");
    return this.mutateBoard(wsId, (board) => {
      orderedIds.forEach((id, idx) => {
        const ticket = board.tickets.find((t) => t.id === id && t.status === status);
        if (ticket) ticket.sort_order = idx;
      });
    });
  }

  // ------------------------------------------------------------- attachments

  async addAttachment(wsId, ticketId, file) {
    const attId = newId();
    const filename = safeFilename(file.name);
    const path = await this.attachmentPath(attId, filename);
    await this.writeFile(path, file, filename);
    return this.mutateBoard(wsId, (board) => {
      const ticket = board.tickets.find((t) => t.id === ticketId);
      if (!ticket) throw new Error("ticket not found");
      const attachment = {
        id: attId,
        filename,
        content_type: file.type || "application/octet-stream",
        size: file.size,
        created_at: nowTs(),
        path,
      };
      ticket.attachments.push(attachment);
      return attachment;
    });
  }

  /* An <img src> cannot send the session key, so attachment bytes are fetched
     through the authenticated client and handed to the DOM as a blob URL.

     The host client parses octet-stream bodies as text, which would corrupt
     binary image data, so this goes through `fetchBlob` instead of `request`. */
  async attachmentUrl(attachment) {
    const blob = await this.fetchBlob(attachment.path, attachment.content_type);
    return URL.createObjectURL(blob);
  }
}

export function isNotFound(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 404) return true;
  return /\b404\b|not found/i.test(err?.message || "");
}
