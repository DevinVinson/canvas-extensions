/* vibe — agent dispatch board, as an Agent Canvas extension.

   This is the SPA from static/app.js adapted to the extension ABI. The three
   structural differences from the standalone build:

   1. Scoping. The SPA owns a whole document and looks elements up with
      document.querySelector; here every lookup is rooted at the container
      Canvas hands us, so two mounts can never collide and we never touch
      Canvas's DOM.
   2. Lifecycle. Everything that outlives a statement - timers, listeners,
      in-flight fetches - is registered with a disposer, because Canvas mounts
      and unmounts us repeatedly (enable/disable, route changes, backend
      switches) and cleanup is our responsibility.
   3. Routing. The SPA owns location.pathname (/workspace/<name>); an extension
      page only owns the remainder below its declared path, and navigates
      through the host so Canvas's base path keeps working.
*/

import { BOARD_MARKUP } from "./markup.js";
import { Store } from "./store.js";
import { Live } from "./live.js";
import { Manager } from "./manager.js";

const HOST_API_VERSION = "1";
// Canvas routes extension pages at /extensions/<extension>/<declared page path>.
const PAGE_ROOT = "/extensions/kanban-manager/board";
const STYLE_ELEMENT_ID = "vibe-ext-style";

// Injected by build.mjs: the SPA stylesheet, scoped under .vibe-ext.
const EXTENSION_CSS = typeof __VIBE_CSS__ === "string" ? __VIBE_CSS__ : "";

const STATUS_LABEL = {
  pending: "pending",
  in_progress: "in progress",
  needs_input: "needs you",
  finished: "finished",
  verified: "verified",
};

// An empty lane is an invitation to act, not a blank box.
const LANE_EMPTY = {
  pending: "Nothing queued. Send a request above.",
  in_progress: "No agent is working right now.",
  needs_input: "Nothing is waiting on you.",
  finished: "Finished work lands here for a look.",
  verified: "Verified work is filed here.",
};

const BOARD_POLL_MS = 5000;
const AUTOMATION_POLL_MS = 15000;
const TRIGGER_HINT = "Click to run the manager now";

/* ------------------------------------------------------------------ styles */

/* One <style> shared by every mount, reference-counted so the last unmount
   removes it. Canvas can mount the page again immediately after unmounting
   (a route change), so tying the stylesheet to a single mount would flash
   unstyled content. */
let styleRefCount = 0;

function acquireStyle() {
  styleRefCount += 1;
  let el = document.getElementById(STYLE_ELEMENT_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ELEMENT_ID;
    el.textContent = EXTENSION_CSS;
    document.head.appendChild(el);
  }
  return () => {
    styleRefCount = Math.max(0, styleRefCount - 1);
    if (styleRefCount === 0) el.remove();
  };
}

/* -------------------------------------------------------------- formatting */

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(contentType) {
  return (contentType || "").startsWith("image/");
}

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtAgo(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function shortModel(model) {
  // "anthropic/claude-fable-5" -> "claude-fable-5"; full name stays in the tooltip.
  return model.split("/").pop();
}

/* ------------------------------------------------------------------ mount */

/**
 * Render the board into `container`.
 *
 * @returns {() => void} disposer that removes all DOM, timers and listeners.
 */
export function mountBoard({ container, path, navigate, host }) {
  const root = document.createElement("div");
  root.className = "vibe-ext";
  root.innerHTML = BOARD_MARKUP;
  container.appendChild(root);

  const releaseStyle = acquireStyle();

  // Every listener/timer goes through these so disposal is total.
  const cleanups = [releaseStyle];
  let disposed = false;

  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];

  function on(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    cleanups.push(() => target.removeEventListener(type, handler, opts));
  }

  function every(ms, fn) {
    const id = setInterval(fn, ms);
    cleanups.push(() => clearInterval(id));
    return id;
  }

  const store = new Store(host);
  const state = {
    store,
    live: new Live(host),
    manager: new Manager(host, store),
    workspaces: { available: [], selected: [] },
    ws: null,
    tickets: [],
    drawerTicketId: null,
    automation: null,
    dragging: null,
    returnFocus: null,
    showVerified: readFlag("vibe.showVerified"),
    newTicketFiles: [],
    theme: readTheme(),
    pollTimer: null,
    automationTimer: null,
  };

  function readFlag(key) {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  }

  function readTheme() {
    try {
      return localStorage.getItem("vibe.theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  }

  function persist(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage disabled - preference just won't survive a reload */
    }
  }

  /* A late fetch must never write into a disposed mount. Every async handler
     checks this after awaiting. */
  const alive = () => !disposed;

  /* ----------------------------------------------------------- board store */

  function showSetup(message) {
    $("#api-setup").hidden = false;
    $("#empty-state").hidden = true;
    $("#board-wrap").hidden = true;
    $("#ctl-concurrency").hidden = true;
    $("#ctl-pushmode").hidden = true;
    $("#show-verified").hidden = true;
    $("#mgr-badge").hidden = true;
    $("#mgr-stop").hidden = true;
    const err = $("#api-setup-error");
    err.hidden = !message;
    err.textContent = message || "";
  }

  /** Open the store on this Canvas backend's agent server. */
  async function connect() {
    try {
      // Resolving the root proves the file API is reachable and writable
      // before the board starts polling it.
      await state.store.storeRoot();
    } catch (e) {
      if (!alive()) return false;
      showSetup(
        `Couldn't reach the agent server's file API (${e.message}). ` +
          "The board is stored on the agent server, so it needs to be running.",
      );
      return false;
    }
    if (!alive()) return false;
    $("#api-setup").hidden = true;
    await start();
    return true;
  }

  /* Conversations live in Canvas itself, so these route through the host
     instead of opening a new tab. The href stays real for middle-click. */
  function conversationLink(t, label) {
    const a = document.createElement("a");
    a.className = "chip convo";
    a.href = t.conversation_url;
    a.textContent = `↗ ${label}`;
    a.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(t.conversation_url);
    });
    return a;
  }

  /* --------------------------------------------------------- attachments */

  /* Blob URLs are cached per attachment id: the board re-renders every 5s and
     each render would otherwise re-download every visible image, and leak the
     previous URL. Revoked wholesale on unmount. */
  const blobUrls = new Map();
  cleanups.push(() => {
    for (const url of blobUrls.values()) URL.revokeObjectURL(url);
    blobUrls.clear();
  });

  function objectUrl(a) {
    let pending = blobUrls.get(a.id);
    if (typeof pending === "string") return Promise.resolve(pending);
    if (pending) return pending;
    pending = state.store.attachmentUrl(a).then((url) => {
      blobUrls.set(a.id, url);
      return url;
    }).catch((err) => {
      blobUrls.delete(a.id); // let a later render retry
      throw err;
    });
    blobUrls.set(a.id, pending);
    return pending;
  }

  function attachmentEl(a) {
    const link = document.createElement("a");
    /* Attachment bytes live on the agent server's filesystem, which is only
       readable with the session key — so there is no plain URL to point at.
       The blob URL is fetched lazily and revoked on unmount. */
    link.href = "#";
    link.target = "_blank";
    link.rel = "noopener";
    link.title = `${a.filename} · ${fmtSize(a.size)}`;
    const load = () => objectUrl(a);
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        window.open(await load(), "_blank", "noopener");
      } catch (err) {
        console.error("vibe: could not open attachment", err);
      }
    });
    if (isImage(a.content_type)) {
      link.className = "att att-thumb";
      const img = document.createElement("img");
      img.alt = a.filename;
      img.loading = "lazy";
      load().then((u) => { if (alive()) img.src = u; })
        .catch((err) => console.error("vibe: could not load thumbnail", err));
      link.appendChild(img);
    } else {
      link.className = "att att-file";
      link.textContent = `📎 ${a.filename}`;
    }
    const size = document.createElement("span");
    size.className = "att-size";
    size.textContent = isImage(a.content_type) ? "" : ` ${fmtSize(a.size)}`;
    link.appendChild(size);
    return link;
  }

  /* ---------------------------------------------------------- workspaces */

  async function loadWorkspaces() {
    const data = await state.store.listWorkspaces();
    if (!alive()) return;
    state.workspaces = data;
    const sel = $("#workspace-select");
    const current = sel.value;
    sel.innerHTML = '<option value="">Choose a workspace</option>';

    const selectedPaths = new Set(data.selected.map((w) => w.path));
    if (data.selected.length) {
      const og = document.createElement("optgroup");
      og.label = "active";
      for (const w of data.selected) {
        const o = document.createElement("option");
        o.value = w.path;
        o.textContent = w.name;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    const avail = data.available.filter((a) => !selectedPaths.has(a.path));
    if (avail.length) {
      const og = document.createElement("optgroup");
      og.label = "available";
      for (const a of avail) {
        const o = document.createElement("option");
        o.value = a.path;
        o.textContent = a.name;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    sel.value = current || readWorkspacePref();
  }

  function readWorkspacePref() {
    try {
      return localStorage.getItem("vibe.workspace") ?? "";
    } catch {
      return "";
    }
  }

  /* Routing. The SPA pushed /workspace/<name>; here the workspace name is the
     route remainder below the page path, and navigation goes through the host
     so Canvas's base path and history stay authoritative. */
  function workspaceNameFromRoute(remainder) {
    const first = (remainder || "").split("/")[0];
    return first ? decodeURIComponent(first) : null;
  }

  function workspacePathFromName(name) {
    const all = [...(state.workspaces.selected || []), ...(state.workspaces.available || [])];
    return all.find((w) => w.name === name)?.path ?? null;
  }

  function syncRoute(mode) {
    if (mode === "none") return;
    const target = state.ws?.name
      ? `${PAGE_ROOT}/${encodeURIComponent(state.ws.name)}`
      : PAGE_ROOT;
    if (window.location.pathname !== target) navigate(target);
  }

  async function selectWorkspace(path, { historyMode = "push" } = {}) {
    if (!path) {
      state.ws = null;
      try {
        localStorage.removeItem("vibe.workspace");
      } catch {
        /* storage disabled */
      }
      stopPolling();
      syncRoute(historyMode);
      render();
      return;
    }
    try {
      const ws = await state.store.selectWorkspace(path);
      if (!alive()) return;
      state.ws = ws;
      state.automation = null;
      persist("vibe.workspace", path);
      syncRoute(historyMode);
      await refreshBoard();
      if (!alive()) return;
      startPolling();
      await loadWorkspaces();
      if (!alive()) return;
      $("#workspace-select").value = path;
    } catch (e) {
      if (alive()) console.error(`workspace error: ${e.message}`);
    }
    if (alive()) render();
  }

  /* --------------------------------------------------------------- board */

  async function refreshBoard() {
    if (!state.ws) return;
    /* A poll reads the board every 5s, so one is often in flight while the
       user submits. Its response was captured before the write and would
       render the board without the new card; the write does its own refresh,
       so drop anything read across a write instead. */
    const writes = state.store.writes;
    try {
      const data = await state.store.getBoard(state.ws.id);
      if (!alive() || state.store.writes !== writes) return;
      state.ws = data.workspace;
      /* The old service computed these server-side; inside Canvas they come
         from the agent server directly, cached and refreshed in the
         background so a 5s poll never blocks on them. */
      state.tickets = state.live.decorate(data.tickets, "");
      renderBoard();
      renderSettings();
      if (state.drawerTicketId) renderDrawer();
    } catch (e) {
      if (alive()) console.error(e);
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(refreshBoard, BOARD_POLL_MS);
    state.automationTimer = setInterval(refreshAutomation, AUTOMATION_POLL_MS);
    refreshAutomation();
  }

  function stopPolling() {
    clearInterval(state.pollTimer);
    clearInterval(state.automationTimer);
    state.pollTimer = null;
    state.automationTimer = null;
  }
  cleanups.push(stopPolling);

  /* ----------------------------------------------- manager automation badge */

  async function refreshAutomation() {
    if (!state.ws) return;
    try {
      const data = await state.live.automationStatus(state.ws);
      if (!alive()) return;
      state.automation = data;
    } catch (e) {
      if (alive()) console.error(e);
    }
    if (alive()) renderMgrBadge();
  }

  /* No manager for this workspace: it was never created, it was stopped, or
     the automation it points at is gone. All three are the same offer to the
     user — start one — so they share a predicate. */
  function needsStart() {
    const a = state.automation;
    return !state.ws?.automation_id || a?.missing === true || a?.enabled === false;
  }

  async function triggerManager() {
    if (!state.ws || !state.ws.automation_id) return;
    const badge = $("#mgr-badge");
    if (badge.classList.contains("triggering")) return;
    badge.classList.add("triggering");
    $("#mgr-text").textContent = "manager: triggering…";
    try {
      await state.live.triggerAutomation(state.ws);
    } catch (e) {
      if (alive()) console.error(`manager trigger failed: ${e.message}`);
    }
    if (!alive()) return;
    badge.classList.remove("triggering");
    refreshAutomation();
  }

  /* Creates the automation the SPA used to get from app.py's bootstrap, then
     records its id on the workspace so every other reader (the badge, the
     manager's own CLI) finds it. */
  async function startManager() {
    const badge = $("#mgr-badge");
    if (!state.ws || badge.classList.contains("triggering")) return;
    badge.classList.add("triggering");
    $("#mgr-text").textContent = "manager: starting…";
    try {
      const automationId = await state.manager.ensure(state.ws);
      if (!alive()) return;
      state.ws = await state.store.updateWorkspace(state.ws.id, {
        automation_id: automationId,
      });
      state.automation = null;
    } catch (e) {
      if (alive()) console.error(`manager start failed: ${e.message}`);
    }
    if (!alive()) return;
    badge.classList.remove("triggering");
    await refreshAutomation();
  }

  async function stopManager() {
    const button = $("#mgr-stop");
    if (!state.ws?.automation_id || button.classList.contains("working")) return;
    button.classList.add("working");
    try {
      await state.manager.stop(state.ws.automation_id);
    } catch (e) {
      if (alive()) console.error(`manager stop failed: ${e.message}`);
    }
    if (!alive()) return;
    button.classList.remove("working");
    await refreshAutomation();
  }

  function renderMgrBadge() {
    const badge = $("#mgr-badge");
    const stop = $("#mgr-stop");
    if (!state.ws) {
      badge.hidden = true;
      stop.hidden = true;
      return;
    }
    badge.hidden = false;
    badge.classList.remove("ok", "err", "paused", "start");
    const a = state.automation;
    const text = $("#mgr-text");
    // A start/trigger in flight owns the label until it finishes.
    if (badge.classList.contains("triggering")) return;
    if (needsStart()) {
      stop.hidden = true;
      badge.classList.add("start");
      text.textContent = "Start manager";
      badge.title = state.ws.automation_id
        ? "The manager automation is stopped\nClick to start it again"
        : "No manager is watching this workspace\nClick to create the manager automation";
      return;
    }
    stop.hidden = false;
    if (!a || a.automation_id !== state.ws.automation_id) {
      text.textContent = "manager";
      badge.title = `Manager automation is watching this workspace\n${TRIGGER_HINT}`;
      return;
    }
    // Judge health by the last *finished* run so an in-flight retry (with a
    // once-a-minute cron, one is almost always in flight while runs keep
    // failing) can't mask a failure streak behind a neutral "polling" state.
    const fin = a.last_finished_run;
    const lr = fin || a.last_run;
    const lastWhen = lr ? fmtAgo(lr.completed_at || lr.started_at || lr.created_at) : "";
    const runsFailing = !!(fin && fin.status !== "COMPLETED");
    const convStatus = a.manager_conversation?.status;
    const convRunning = convStatus === "running";
    const convFailing = convStatus === "error" || convStatus === "stuck";
    const tip = [];
    let label;
    let cls = "";
    if (a.error) {
      label = "manager: unknown";
      cls = "err";
      tip.push(a.error);
    } else if (runsFailing) {
      label = `manager ✗ ${lastWhen}`;
      cls = "err";
      if (a.consecutive_failures > 1) tip.push(`${a.consecutive_failures} runs failed in a row`);
      if (a.run_active) tip.push("retry run in progress");
      if (convRunning) tip.push("manager agent conversation still running");
    } else if (convFailing) {
      label = `manager: agent ${convStatus}`;
      cls = "err";
      tip.push(`Manager agent conversation is ${convStatus}`);
    } else if (convRunning) {
      label = "manager: working";
      tip.push("Manager agent conversation is running right now");
    } else if (a.run_active) {
      label = "manager: polling";
      tip.push("Automation run in progress");
    } else if (lr) {
      label = `manager ✓ ${lastWhen}`;
      cls = "ok";
    } else {
      label = "manager";
    }
    if (lr) {
      tip.push(`last run: ${(lr.status || "?").toLowerCase()} ${lastWhen}`.trim());
      if (lr.error_detail) tip.push(`error: ${lr.error_detail}`);
    }
    if (a.last_triggered_at) tip.push(`last triggered ${fmtAgo(a.last_triggered_at)}`);
    if (a.manager_conversation) tip.push(`manager agent: ${a.manager_conversation.status}`);
    tip.push(TRIGGER_HINT);
    text.textContent = label;
    if (cls) badge.classList.add(cls);
    badge.title = tip.join("\n");
  }

  function render() {
    const has = !!state.ws;
    $("#empty-state").hidden = has;
    $("#board-wrap").hidden = !has;
    $("#ctl-concurrency").hidden = !has;
    $("#ctl-pushmode").hidden = !has;
    $("#show-verified").hidden = !has;
    renderMgrBadge();
    if (has) {
      renderBoard();
      renderSettings();
    }
  }

  function renderSettings() {
    if (!state.ws) return;
    const mc = $("#max-concurrent");
    if (document.activeElement !== mc) mc.value = state.ws.max_concurrent;
    $$("#push-mode .seg-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === state.ws.push_mode),
    );
    renderMgrBadge();
  }

  function modelChip(model) {
    const chip = document.createElement("span");
    chip.className = "chip model";
    chip.title = model;
    chip.textContent = `◆ ${shortModel(model)}`;
    return chip;
  }

  function cardEl(t) {
    const firstEntry = t.entries[0]?.body ?? "";
    const el = document.createElement("div");
    el.className = "card";
    el.dataset.id = t.id;
    // finished + verified columns are time-ordered (most recent first), not
    // priority-ordered, so their cards aren't draggable.
    el.draggable = t.status !== "verified" && t.status !== "finished";
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute(
      "aria-label",
      `Open request ${t.title || t.entries[0]?.body?.slice(0, 60) || t.id.slice(0, 6)}`,
    );

    if (t.title) {
      const title = document.createElement("div");
      title.className = "card-title";
      title.textContent = t.title;
      el.appendChild(title);
    }

    const body = document.createElement("div");
    body.className = "card-body";
    body.textContent = firstEntry;
    el.appendChild(body);

    if (t.manager_note) {
      const note = document.createElement("div");
      note.className = "card-note";
      note.textContent = `⚑ ${t.manager_note}`;
      el.appendChild(note);
    }

    if (t.status === "in_progress" && t.latest_action?.summary) {
      el.classList.add("live");
      const act = document.createElement("div");
      act.className = "card-activity";
      act.title = t.latest_action.tool ? `tool: ${t.latest_action.tool}` : "";
      const dot = document.createElement("span");
      dot.className = "activity-dot";
      act.appendChild(dot);
      const text = document.createElement("span");
      text.className = "activity-text";
      text.textContent = t.latest_action.summary;
      act.appendChild(text);
      el.appendChild(act);
    }

    const meta = document.createElement("div");
    meta.className = "card-meta";
    const id = document.createElement("span");
    id.textContent = `#${t.id.slice(0, 6)}`;
    meta.appendChild(id);
    if (t.llm_model) meta.appendChild(modelChip(t.llm_model));
    if (t.status === "verified" && t.verified_at) {
      const when = document.createElement("span");
      when.className = "chip verified";
      when.textContent = `✓ ${fmtTime(t.verified_at)}`;
      meta.appendChild(when);
    }
    if (t.entries.length > 1) {
      const chip = document.createElement("span");
      chip.className = "chip entries";
      chip.textContent = `${t.entries.length} entries`;
      meta.appendChild(chip);
    }
    if ((t.attachments || []).length) {
      const chip = document.createElement("span");
      chip.className = "chip attachments";
      chip.textContent = `📎 ${t.attachments.length}`;
      meta.appendChild(chip);
    }
    if (t.conversation_url) {
      meta.appendChild(conversationLink(t, "conversation"));
    }
    if (t.pr_url) {
      const a = document.createElement("a");
      a.className = "chip pr";
      a.href = t.pr_url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "↗ pull request";
      a.addEventListener("click", (e) => e.stopPropagation());
      meta.appendChild(a);
    }
    el.appendChild(meta);

    if (t.status === "finished") {
      const btn = document.createElement("button");
      btn.className = "verify-btn";
      btn.textContent = "Mark verified";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        verifyTicket(t.id);
      });
      el.appendChild(btn);
    }

    if (el.draggable) {
      const handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.textContent = "⋮⋮";
      el.appendChild(handle);
    }

    el.addEventListener("click", () => openDrawer(t.id));
    el.addEventListener("keydown", (e) => {
      if (e.target !== el) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDrawer(t.id);
      }
    });
    el.addEventListener("dragstart", (e) => {
      state.dragging = { id: t.id, status: t.status };
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", t.id);
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      $$(".card").forEach((c) => c.classList.remove("drop-above", "drop-below"));
      state.dragging = null;
    });
    el.addEventListener("dragover", (e) => {
      if (!state.dragging || state.dragging.id === t.id || state.dragging.status !== t.status)
        return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      el.classList.toggle("drop-above", above);
      el.classList.toggle("drop-below", !above);
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-above", "drop-below"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      if (!state.dragging || state.dragging.status !== t.status) return;
      const rect = el.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      el.classList.remove("drop-above", "drop-below");
      await reorderWithin(t.status, state.dragging.id, t.id, above);
    });
    return el;
  }

  function renderBoard() {
    $('.col[data-status="verified"]').hidden = !state.showVerified;
    $("#board").classList.toggle("show-verified", state.showVerified);
    for (const status of Object.keys(STATUS_LABEL)) {
      const container_ = $(`.col-cards[data-status="${status}"]`);
      container_.innerHTML = "";
      const tickets = state.tickets
        .filter((t) => t.status === status)
        .sort((a, b) =>
          status === "verified"
            ? (b.verified_at ?? b.updated_at) - (a.verified_at ?? a.updated_at)
            : status === "finished"
              ? (b.finished_at ?? b.updated_at) - (a.finished_at ?? a.updated_at)
              : a.sort_order - b.sort_order || a.created_at - b.created_at,
        );
      if (tickets.length) {
        for (const t of tickets) container_.appendChild(cardEl(t));
      } else {
        const empty = document.createElement("p");
        empty.className = "lane-empty";
        empty.textContent = LANE_EMPTY[status];
        container_.appendChild(empty);
      }
      $(`.col[data-status="${status}"] .col-count`).textContent = tickets.length || "";
    }
  }

  async function reorderWithin(status, draggedId, targetId, above) {
    const ordered = state.tickets
      .filter((t) => t.status === status)
      .sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at)
      .map((t) => t.id)
      .filter((id) => id !== draggedId);
    const idx = ordered.indexOf(targetId);
    ordered.splice(above ? idx : idx + 1, 0, draggedId);
    // optimistic update
    ordered.forEach((id, i) => {
      const t = state.tickets.find((x) => x.id === id);
      if (t) t.sort_order = i;
    });
    renderBoard();
    try {
      await state.store.reorder(state.ws.id, status, ordered);
    } catch (e) {
      if (!alive()) return;
      console.error(`reorder failed: ${e.message}`);
      refreshBoard();
    }
  }

  /* ------------------------------------------------------------- tickets */

  async function submitTicket() {
    const ta = $("#new-ticket-body");
    const body = ta.value.trim();
    if (!body || !state.ws) return;
    const btn = $("#new-ticket-submit");
    btn.disabled = true;
    try {
      const ticket = await state.store.createTicket(state.ws.id, body);
      if (!alive()) return;
      ta.value = "";
      const files = state.newTicketFiles.splice(0);
      renderNewTicketFiles();
      const failed = [];
      for (const f of files) {
        try {
          await state.store.addAttachment(state.ws.id, ticket.id, f);
        } catch (e) {
          failed.push(e.message);
        }
      }
      if (!alive()) return;
      if (failed.length)
        console.error(`ticket submitted, but upload failed: ${failed.join("; ")}`);
      await refreshBoard();
    } catch (e) {
      if (alive()) console.error(`submit failed: ${e.message}`);
    } finally {
      if (alive()) btn.disabled = false;
    }
  }

  function renderNewTicketFiles() {
    const wrap = $("#new-ticket-files");
    wrap.innerHTML = "";
    wrap.hidden = !state.newTicketFiles.length;
    state.newTicketFiles.forEach((f, i) => {
      const chip = document.createElement("span");
      chip.className = "file-chip";
      chip.textContent = `${isImage(f.type) ? "🖼" : "📎"} ${f.name} · ${fmtSize(f.size)}`;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "file-chip-rm";
      rm.textContent = "✕";
      rm.title = "remove";
      rm.addEventListener("click", () => {
        state.newTicketFiles.splice(i, 1);
        renderNewTicketFiles();
      });
      chip.appendChild(rm);
      wrap.appendChild(chip);
    });
  }

  async function uploadDrawerFiles(files) {
    if (!state.drawerTicketId || !files.length) return;
    const failed = [];
    for (const f of files) {
      try {
        await state.store.addAttachment(state.ws.id, state.drawerTicketId, f);
      } catch (e) {
        failed.push(e.message);
      }
    }
    if (!alive()) return;
    if (failed.length) console.error(`upload failed: ${failed.join("; ")}`);
    await refreshBoard();
  }

  async function verifyTicket(id) {
    try {
      await state.store.verifyTicket(state.ws.id, id);
      if (!alive()) return;
      await refreshBoard();
    } catch (e) {
      if (alive()) console.error(`verify failed: ${e.message}`);
    }
  }

  function toggleVerified() {
    state.showVerified = !state.showVerified;
    persist("vibe.showVerified", state.showVerified ? "1" : "0");
    renderVerifiedToggle();
    renderBoard();
  }

  function renderVerifiedToggle() {
    const btn = $("#show-verified");
    btn.textContent = state.showVerified ? "Hide verified" : "Show verified";
    btn.classList.toggle("active", state.showVerified);
  }

  /* -------------------------------------------------------------- drawer */

  function openDrawer(ticketId) {
    state.returnFocus = document.activeElement;
    state.drawerTicketId = ticketId;
    $("#drawer").hidden = false;
    renderDrawer();
    $("#append-body").focus();
  }

  function closeDrawer() {
    if (!state.drawerTicketId) return;
    state.drawerTicketId = null;
    $("#drawer").hidden = true;
    const back = state.returnFocus;
    state.returnFocus = null;
    if (back?.isConnected) back.focus();
  }

  function renderDrawer() {
    const t = state.tickets.find((x) => x.id === state.drawerTicketId);
    if (!t) {
      closeDrawer();
      return;
    }
    const st = $("#drawer-status");
    st.textContent = STATUS_LABEL[t.status];
    st.dataset.s = t.status;
    $("#drawer-id").textContent = `#${t.id}`;
    const title = $("#drawer-title");
    title.hidden = !t.title;
    title.textContent = t.title || "";

    const links = $("#drawer-links");
    links.innerHTML = "";
    if (t.conversation_url) {
      links.appendChild(conversationLink(t, "open conversation"));
    }
    if (t.pr_url) {
      const a = document.createElement("a");
      a.className = "chip pr";
      a.href = t.pr_url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "↗ open pull request";
      links.appendChild(a);
    }
    if (t.llm_model) links.appendChild(modelChip(t.llm_model));

    const note = $("#drawer-note");
    note.hidden = !t.manager_note;
    note.textContent = t.manager_note ? `⚑ manager: ${t.manager_note}` : "";

    const activity = $("#drawer-activity");
    const act = t.status === "in_progress" ? t.latest_action : null;
    activity.hidden = !act?.summary;
    activity.innerHTML = "";
    if (act?.summary) {
      activity.title = act.tool ? `tool: ${act.tool}` : "";
      const dot = document.createElement("span");
      dot.className = "activity-dot";
      activity.appendChild(dot);
      const text = document.createElement("span");
      text.className = "activity-text";
      text.textContent = act.summary;
      activity.appendChild(text);
    }

    const atts = $("#drawer-attachments");
    atts.innerHTML = "";
    atts.hidden = !(t.attachments || []).length;
    for (const a of t.attachments || []) atts.appendChild(attachmentEl(a));

    const thread = $("#drawer-thread");
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
    thread.innerHTML = "";
    for (const e of t.entries) {
      const div = document.createElement("div");
      div.className = "entry";
      const head = document.createElement("div");
      head.className = "entry-head";
      const author = document.createElement("span");
      author.className = `entry-author-${e.author}`;
      author.textContent = e.author;
      const when = document.createElement("span");
      when.textContent = fmtTime(e.created_at);
      head.append(author, when);
      const body = document.createElement("div");
      body.className = "entry-body";
      body.textContent = e.body;
      div.append(head, body);
      thread.appendChild(div);
    }
    if (atBottom) thread.scrollTop = thread.scrollHeight;
  }

  async function appendEntry() {
    const ta = $("#append-body");
    const body = ta.value.trim();
    if (!body || !state.drawerTicketId) return;
    try {
      await state.store.appendEntry(state.ws.id, state.drawerTicketId, body);
      if (!alive()) return;
      ta.value = "";
      await refreshBoard();
    } catch (e) {
      if (alive()) console.error(`append failed: ${e.message}`);
    }
  }

  /* ------------------------------------------------------------ settings */

  async function patchWorkspace(patch) {
    if (!state.ws) return;
    try {
      const ws = await state.store.updateWorkspace(state.ws.id, patch);
      if (!alive()) return;
      state.ws = ws;
      renderSettings();
    } catch (e) {
      if (alive()) console.error(`settings failed: ${e.message}`);
    }
  }

  /* --------------------------------------------------------------- theme */

  function applyTheme() {
    // Scoped to our own root: the SPA set this on <html>, which inside Canvas
    // would restyle the host application.
    if (state.theme === "light") root.dataset.theme = "light";
    else delete root.dataset.theme;
  }

  /* ---------------------------------------------------------------- wire */

  function ticketKeydown(submit) {
    return (e) => {
      if (e.key !== "Enter") return;
      // Shift+Enter inserts a newline; Enter and Cmd/Ctrl+Enter submit.
      if (e.shiftKey) return;
      e.preventDefault();
      submit();
    };
  }

  function wire() {
    on($("#api-retry"), "click", () => connect());

    on($("#workspace-select"), "change", (e) => selectWorkspace(e.target.value));

    on($("#new-ticket-form"), "submit", (e) => {
      e.preventDefault();
      submitTicket();
    });
    on($("#new-ticket-body"), "keydown", ticketKeydown(submitTicket));

    on($("#new-ticket-attach"), "click", () => $("#new-ticket-file-input").click());
    on($("#new-ticket-file-input"), "change", (e) => {
      state.newTicketFiles.push(...e.target.files);
      e.target.value = "";
      renderNewTicketFiles();
    });

    on($("#append-form"), "submit", (e) => {
      e.preventDefault();
      appendEntry();
    });
    on($("#append-body"), "keydown", ticketKeydown(appendEntry));

    on($("#drawer-attach"), "click", () => $("#drawer-file-input").click());
    on($("#drawer-file-input"), "change", async (e) => {
      const files = [...e.target.files];
      e.target.value = "";
      await uploadDrawerFiles(files);
    });

    on($("#drawer-close"), "click", closeDrawer);
    on($("#drawer-backdrop"), "click", closeDrawer);
    // Document-level so Escape works wherever focus is - removed on dispose.
    on(document, "keydown", (e) => {
      if (e.key === "Escape") closeDrawer();
    });

    on($("#max-concurrent"), "change", (e) => {
      const v = parseInt(e.target.value, 10);
      if (v >= 1 && v <= 20) patchWorkspace({ max_concurrent: v });
    });
    $$("#push-mode .seg-btn").forEach((b) =>
      on(b, "click", () => patchWorkspace({ push_mode: b.dataset.mode })),
    );

    on($("#show-verified"), "click", toggleVerified);
    renderVerifiedToggle();

    // One control, two jobs: start the manager when there isn't one, run it
    // now when there is.
    const badgeAction = () => (needsStart() ? startManager() : triggerManager());
    on($("#mgr-badge"), "click", badgeAction);
    on($("#mgr-badge"), "keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        badgeAction();
      }
    });
    on($("#mgr-stop"), "click", stopManager);
    applyTheme();
  }

  /* ---------------------------------------------------------------- boot */

  async function start() {
    await loadWorkspaces();
    if (!alive()) return;

    const routeName = workspaceNameFromRoute(path);
    const routePath = routeName ? workspacePathFromName(routeName) : null;
    const saved = readWorkspacePref();
    const savedOk =
      saved && [...$("#workspace-select").options].some((o) => o.value === saved);
    const target = routePath || (savedOk ? saved : null);

    if (target) {
      $("#workspace-select").value = target;
      await selectWorkspace(target, { historyMode: "none" });
    } else {
      if (routeName) console.error(`unknown workspace: ${routeName}`);
      render();
    }
  }

  wire();

  /* No configuration step: the board lives on the agent server this Canvas
     backend is already connected to. connect() renders the setup screen
     itself if the file API can't be reached, with the reason. */
  connect();

  return () => {
    disposed = true;
    for (const fn of cleanups.reverse()) {
      try {
        fn();
      } catch (e) {
        console.error("vibe extension cleanup failed", e);
      }
    }
    root.remove();
  };
}

/* -------------------------------------------------------------- activate */

export function activate(host) {
  if (host.apiVersion !== HOST_API_VERSION) {
    throw new Error(
      `kanban-manager requires Canvas host API ${HOST_API_VERSION}, got ${host.apiVersion}.`,
    );
  }
  // The page id is written as a literal (rather than the PAGE_ID constant) so
  // static validators can match it against the manifest.
  return host.registerPage("board", (context) => mountBoard({ ...context, host }));
}
