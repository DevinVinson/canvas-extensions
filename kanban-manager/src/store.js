/* Board state on disk, reached through the agent-server file API.

   Replaces the vibe-manager FastAPI service. Every call goes through the
   Canvas host's `agentServer.request`, which targets the active backend and
   attaches the session key — so there is no base URL to configure, no
   credentials to manage, and no cross-origin request to be blocked.

   Layout is documented in store/SCHEMA.md: an index.json listing workspaces,
   and one board.json per workspace holding its tickets with entries and
   attachments embedded.

   Writes are read-modify-write of a whole document, and the browser is not
   the only writer: the automation and the manager's CLI write the same files
   from the shell, where no lock can span the file API. Every write therefore
   carries a `rev` and a `writer` token, and `mutateDoc` re-applies the
   mutation when another writer got in — see SCHEMA.md. */

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

/* Stamp a document for the next write: `rev` counts writes so a racing writer
   is detectable, `writer` identifies this one so we can tell our own write
   from someone else's. Both are read by the shell side too (vibestore.py). */
export function stamp(doc, fields) {
  return { ...doc, ...fields, rev: (doc.rev || 0) + 1, writer: newId() };
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
    this.mutationChain = Promise.resolve();
    /* Completed board writes. The UI reads this to tell a poll response that
       predates a local write from one that reflects it. */
    this.writes = 0;
  }

  /* Run a read-modify-write cycle with no other cycle in flight.

     A cycle is a download, an in-memory edit and an upload of the whole
     document, which takes long enough that a second one started meanwhile
     (a second submit, an attachment, a drag-reorder) downloads the document
     from *before* the first upload and then writes that stale copy back —
     silently dropping the ticket just created. There is no compare-and-set in
     the file API, so for our own writes the fix is not to overlap them; the
     writers outside this tab are caught by `mutateDoc` instead.

     `fn` must not call `serialize` again; the helpers it uses (readBoard,
     writeBoard, readIndex, writeIndex) are deliberately unserialized. */
  serialize(fn) {
    const done = this.mutationChain.then(fn);
    // A rejected cycle must not poison the queue, nor look unhandled here.
    this.mutationChain = done.then(() => {}, () => {});
    return done;
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

  /* Read, apply `mutate`, write back — retrying when another writer lands in
     between. Both checks are needed: the file API offers no conditional
     upload, so a race is detected rather than prevented. Re-reading before
     the upload catches a write that arrived while we were preparing ours
     (theirs would otherwise be overwritten); re-reading after it catches a
     writer that had already read the pre-change document and overwrote us
     (our ticket would otherwise be silently dropped). */
  async mutateDoc(path, read, write, mutate, attempts = 5) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const doc = await read();
      const base = doc.rev || 0;
      const result = mutate(doc);
      const current = await read();
      if ((current.rev || 0) !== base) continue;
      const token = await write(doc);
      const after = await read();
      // `rev > base + 1` means someone built on top of our write, so it landed.
      if (after.writer === token || (after.rev || 0) > base + 1) return result;
    }
    throw new Error(`${path.split("/").pop()} is being written concurrently; try again`);
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

  /** Writes the index and returns the token that identifies this write. */
  async writeIndex(index) {
    const stamped = stamp(index, { version: 1 });
    await this.writeJson(await this.indexPath(), stamped);
    return stamped.writer;
  }

  async mutateIndex(mutate) {
    const path = await this.indexPath();
    return this.serialize(() => this.mutateDoc(
      path,
      () => this.readIndex(),
      (index) => this.writeIndex(index),
      mutate,
    ));
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
    const existing = (await this.readIndex()).workspaces.find((w) => w.path === path);
    if (existing) return existing;

    let created = false;
    const ws = await this.mutateIndex((index) => {
      const already = index.workspaces.find((w) => w.path === path);
      created = !already;
      if (already) return already;
      const fresh = {
        id: newId(),
        path,
        name: path.split("/").filter(Boolean).pop() || path,
        max_concurrent: 2,
        push_mode: "main",
        automation_id: null,
        manager_conversation_id: null,
        created_at: nowTs(),
      };
      index.workspaces.push(fresh);
      return fresh;
    });
    if (created) await this.writeBoard(ws.id, { version: 1, workspace_id: ws.id, tickets: [] });
    return ws;
  }

  async updateWorkspace(wsId, patch) {
    return this.mutateIndex((index) => {
      const ws = index.workspaces.find((w) => w.id === wsId);
      if (!ws) throw new Error("workspace not found");
      Object.assign(ws, patch);
      return ws;
    });
  }

  // ------------------------------------------------------------------ boards

  async readBoard(wsId) {
    const board = await this.readJson(await this.boardPath(wsId), null);
    if (!board) return { version: 1, workspace_id: wsId, tickets: [] };
    return { ...board, tickets: board.tickets || [] };
  }

  /** Writes the board and returns the token that identifies this write. */
  async writeBoard(wsId, board) {
    const stamped = stamp(board, { version: 1, workspace_id: wsId });
    await this.writeJson(await this.boardPath(wsId), stamped);
    this.writes += 1;
    return stamped.writer;
  }

  /** Read, apply `mutate`, write back. Returns whatever `mutate` returns.
      Serialized against our own cycles, and retried against everyone else's:
      see `serialize` and `mutateDoc`. */
  async mutateBoard(wsId, mutate) {
    const path = await this.boardPath(wsId);
    return this.serialize(() => this.mutateDoc(
      path,
      () => this.readBoard(wsId),
      (board) => this.writeBoard(wsId, board),
      mutate,
    ));
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
