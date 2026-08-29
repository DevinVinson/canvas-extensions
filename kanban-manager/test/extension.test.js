/* Tests run against the BUILT bundle (dist/extension.js), not the sources, so
   they also cover the build: CSS scoping, the rem rescale, and the absence of
   bare imports are all properties of the artifact Canvas actually loads.

   Run: npm test  (after npm run build)
*/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(
  readFileSync(join(here, "..", "canvas-extension.json"), "utf8"),
);
// The bundle is wherever the manifest says the entrypoint is.
const DIST = join(here, "..", MANIFEST.entrypoint);

/* linkedom gives us a DOM without a browser. The bundle reads these as
   globals at module scope, so they must exist before it is imported. */
function installDom() {
  const { window, document } = parseHTML(
    "<!doctype html><html><head></head><body></body></html>",
  );
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  /* linkedom exposes HTMLSelectElement.value as a getter only; real browsers
     have a setter that selects the matching <option>. The extension assigns
     select.value (as any DOM code would), so add the missing setter rather
     than contort the extension to suit the test double. */
  const selectValue = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  );
  if (selectValue && !selectValue.set) {
    Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
      get: selectValue.get,
      set(next) {
        for (const option of this.querySelectorAll("option")) {
          if (option.getAttribute("value") === next) option.setAttribute("selected", "");
          else option.removeAttribute("selected");
        }
      },
      configurable: true,
    });
  }

  globalThis.window = window;
  globalThis.document = document;
  globalThis.localStorage = localStorage;
  globalThis.HTMLElement = window.HTMLElement;
  if (!window.location) window.location = { pathname: "/" };
  return { window, document, store };
}

const dom = installDom();
const { activate, mountBoard } = await import(`file://${DIST}`);

/** Minimal host double matching the v1 ABI. */
function makeHost(overrides = {}) {
  const registered = [];
  return {
    apiVersion: "1",
    extension: { name: "kanban-manager", version: "0.1.0", resolvedRef: "test" },
    backend: { id: "test-backend", kind: "local", orgId: null },
    registerPage(id, mount) {
      registered.push({ id, mount });
      return () => registered.splice(0, registered.length);
    },
    navigate() {},
    agentServer: { request: async () => ({}) },
    registered,
    ...overrides,
  };
}

/* The board reaches the agent server only through host.agentServer.request,
   so a host whose request() is programmable is the whole seam. Returns the
   host plus the recorded calls. */
/* Reads use a cache-busting `_` param, so pull `path` out of the query
   properly rather than splitting on "path=". */
function filePath(url) {
  return new URL(url, "http://x").searchParams.get("path") || "";
}

function hostWithStore({
  home = "/home/tester",
  files = {},
  workspaces = {},
  /* What /api/file/search_subdirs reports under every workspace parent. */
  subdirs = [],
  /* Automation backend doubles, keyed by id. `null` for an id the backend
     doesn't have, which is how a deleted automation looks. */
  automations = {},
  createdAutomationId = "auto-created",
  /* Awaited before a download is served, so a test can hold a read open and
     make a response land after something else happened. */
  beforeRead = null,
} = {}) {
  const calls = [];
  const disk = new Map(Object.entries(files));
  const host = makeHost({
    agentServer: {
      async request({ path, method = "GET", body } = {}) {
        calls.push({ path, method, body });
        if (path === "/api/file/home") return { home };
        if (path === "/api/workspaces") return workspaces;
        if (path.startsWith("/api/file/search_subdirs")) return { items: subdirs };
        if (path.startsWith("/api/automation/v1")) {
          const rest = path.slice("/api/automation/v1".length);
          if (method === "POST" && rest === "") return { id: createdAutomationId };
          if (rest.startsWith("?")) return { automations: [] };
          const id = rest.split("/")[1]?.split("?")[0];
          if (method === "PATCH") {
            if (automations[id]) Object.assign(automations[id], body);
            return automations[id] || {};
          }
          if (rest.endsWith("/runs?limit=10")) return { runs: [] };
          if (!automations[id]) {
            const err = new Error("404 not found");
            err.status = 404;
            throw err;
          }
          return automations[id];
        }
        if (path.startsWith("/api/file/download")) {
          const target = filePath(path);
          if (!disk.has(target)) {
            const err = new Error(`404 not found: ${target}`);
            err.status = 404;
            throw err;
          }
          /* A real response carries the bytes as they were when it was
             served, so snapshot before yielding: a caller must not see a
             later write through the object it read, and a held read must
             answer with what the file said when it was requested. */
          const served = structuredClone(disk.get(target));
          if (beforeRead) await beforeRead(target);
          return served;
        }
        if (path.startsWith("/api/file/create_directory")) return {};
        if (path.startsWith("/api/file/upload")) {
          /* The real endpoint takes multipart and stores the file's bytes, so
             unwrap the FormData the store sends and keep parsed JSON on the
             fake disk (which is what download hands back). */
          const target = filePath(path);
          const file = body instanceof FormData ? body.get("file") : null;
          disk.set(target, file ? JSON.parse(await file.text()) : body);
          return {};
        }
        return {};
      },
    },
  });
  return { host, calls, disk };
}

function makeContainer() {
  const el = dom.document.createElement("div");
  dom.document.body.appendChild(el);
  return el;
}

describe("activate", () => {
  it("registers exactly the pages declared in the manifest", () => {
    const host = makeHost();
    activate(host);
    assert.equal(host.registered.length, 1);
    assert.deepEqual(
      host.registered.map((r) => r.id),
      MANIFEST.contributes.pages.map((p) => p.id),
    );
  });

  it("returns the unregister function so Canvas can dispose activation", () => {
    const unregister = () => {};
    const host = makeHost({ registerPage: () => unregister });
    assert.equal(activate(host), unregister);
  });

  it("fails clearly on an unsupported host API version", () => {
    const host = makeHost({ apiVersion: "2" });
    assert.throws(() => activate(host), /requires Canvas host API 1/);
  });
});

describe("mount", () => {
  it("needs no configuration: opens the store on the connected backend", async () => {
    dom.store.clear();
    const { host, calls } = hostWithStore();
    const container = makeContainer();
    const dispose = mountBoard({ container, path: "", navigate: () => {}, host });

    await waitFor(() => calls.some((c) => c.path === "/api/workspaces"));

    assert.equal(calls[0].path, "/api/file/home", "resolves the store root first");
    assert.equal(
      container.querySelector("#api-setup").hasAttribute("hidden"),
      true,
      "no setup screen: there is nothing to configure",
    );
    dispose();
  });

  it("reads the board out of the agent server filesystem", async () => {
    dom.store.clear();
    const workspace = { id: "w1", name: "demo", path: "/git/demo", max_concurrent: 2 };
    const home = "/home/tester";
    const root = `${home}/.openhands/vibe-manager`;
    const { host, calls } = hostWithStore({
      home,
      files: {
        [`${root}/index.json`]: { workspaces: [workspace] },
        [`${root}/workspaces/w1/board.json`]: {
          tickets: [
            {
              id: "t1",
              status: "pending",
              entries: [{ id: "e1", author: "user", body: "hello", created_at: 1 }],
            },
          ],
        },
      },
    });

    const container = makeContainer();
    const dispose = mountBoard({ container, path: "demo", navigate: () => {}, host });

    await waitFor(() => container.textContent.includes("hello"));
    assert.ok(
      calls.some((c) => c.path.includes(encodeURIComponent(`${root}/workspaces/w1/board.json`))),
      "board read from the store path under the resolved home",
    );
    dispose();
  });

  it("renders all five lanes", async () => {
    dom.store.clear();
    const { host } = hostWithStore();
    const container = makeContainer();
    const dispose = mountBoard({ container, path: "", navigate: () => {}, host });
    await waitFor(() => container.querySelector("#empty-state"));
    assert.equal(container.querySelectorAll(".col").length, 5);
    dispose();
  });

  it("surfaces an unreachable agent server instead of failing silently", async () => {
    dom.store.clear();
    const host = makeHost({
      agentServer: {
        request: async () => {
          throw new Error("502 Bad Gateway");
        },
      },
    });
    const container = makeContainer();
    const dispose = mountBoard({ container, path: "", navigate: () => {}, host });

    await waitFor(() => {
      const err = container.querySelector("#api-setup-error");
      return err && !err.hasAttribute("hidden");
    });
    assert.match(
      container.querySelector("#api-setup-error").textContent,
      /Couldn't reach the agent server/,
    );
    dispose();
  });

  it("tolerates a malformed board file without throwing", async () => {
    dom.store.clear();
    const home = "/home/tester";
    const root = `${home}/.openhands/vibe-manager`;
    const { host } = hostWithStore({
      home,
      files: { [`${root}/index.json`]: { nonsense: true } },
    });
    const container = makeContainer();
    const dispose = mountBoard({ container, path: "", navigate: () => {}, host });
    await waitFor(() => container.querySelector("#workspace-select"));
    dispose();
  });

  it("disposer removes all DOM and stops polling", async () => {
    dom.store.clear();
    const { host, calls } = hostWithStore();
    const container = makeContainer();
    const dispose = mountBoard({ container, path: "", navigate: () => {}, host });
    await waitFor(() => calls.length > 0);

    dispose();
    assert.equal(container.childElementCount, 0, "container emptied");

    const afterDispose = calls.length;
    await sleep(60);
    assert.equal(calls.length, afterDispose, "no further requests after dispose");
  });

  it("removes its stylesheet only when the last mount is disposed", () => {
    dom.store.clear();
    const a = makeContainer();
    const b = makeContainer();
    const disposeA = mountBoard({
      container: a, path: "", navigate: () => {}, host: hostWithStore().host,
    });
    const disposeB = mountBoard({
      container: b, path: "", navigate: () => {}, host: hostWithStore().host,
    });

    assert.ok(dom.document.getElementById("vibe-ext-style"), "style injected");
    disposeA();
    assert.ok(
      dom.document.getElementById("vibe-ext-style"),
      "style survives while a mount remains",
    );
    disposeB();
    assert.equal(
      dom.document.getElementById("vibe-ext-style"),
      null,
      "style removed with the last mount",
    );
  });

  it("scopes the light theme to its own root, never the host document", () => {
    dom.store.clear();
    dom.store.set("vibe.theme", "light");
    const container = makeContainer();
    const dispose = mountBoard({
      container,
      path: "",
      navigate: () => {},
      host: hostWithStore().host,
    });
    const root = container.querySelector(".vibe-ext");
    assert.equal(root.getAttribute("data-theme"), "light");
    assert.equal(
      dom.document.documentElement.getAttribute("data-theme"),
      null,
      "host <html> untouched",
    );
    dispose();
  });

  it("treats the route remainder as the workspace name", async () => {
    dom.store.clear();
    const home = "/home/tester";
    const root = `${home}/.openhands/vibe-manager`;
    const workspace = {
      id: "w1",
      name: "demo",
      path: "/git/demo",
      max_concurrent: 3,
      push_mode: "main",
    };
    const { host, calls } = hostWithStore({
      home,
      files: {
        [`${root}/index.json`]: { workspaces: [workspace] },
        [`${root}/workspaces/w1/board.json`]: { tickets: [] },
      },
    });

    const container = makeContainer();
    const dispose = mountBoard({ container, path: "demo", navigate: () => {}, host });

    // Resolving the name to w1 and reading that board is the whole behaviour.
    await waitFor(() =>
      calls.some((c) => c.path.includes(encodeURIComponent(`${root}/workspaces/w1/board.json`))),
    );
    dispose();
  });

  /* Submitting is the one path that writes. It regressed silently once
     (the composer passed {body} where the store wanted a string), so these
     assert the ticket actually lands in the store, not just that a handler
     ran. */
  describe("submitting a new request", () => {
    const home = "/home/tester";
    const root = `${home}/.openhands/vibe-manager`;
    const boardPath = `${root}/workspaces/w1/board.json`;
    const workspace = { id: "w1", name: "demo", path: "/git/demo", max_concurrent: 2 };

    async function mountWithComposer() {
      dom.store.clear();
      const ctx = hostWithStore({
        home,
        files: {
          [`${root}/index.json`]: { workspaces: [workspace] },
          [boardPath]: { version: 1, workspace_id: "w1", tickets: [] },
        },
      });
      const container = makeContainer();
      const dispose = mountBoard({ container, path: "demo", navigate: () => {}, host: ctx.host });
      /* The composer is in the initial markup, so waiting for it would race
         the workspace lookup and submit into a board that isn't open yet. */
      await waitFor(() =>
        ctx.calls.some((c) => c.path.includes(encodeURIComponent(boardPath))),
      );
      return { ...ctx, container, dispose };
    }

    const written = (disk) => disk.get(boardPath).tickets;

    /* linkedom has no KeyboardEvent constructor, so carry the fields the
       handler actually reads on a plain Event. */
    function keydown(key, props = {}) {
      const e = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
      Object.assign(e, { key, shiftKey: false, metaKey: false, ctrlKey: false, ...props });
      return e;
    }

    it("creates the ticket when the form is submitted", async () => {
      const { container, disk, dispose } = await mountWithComposer();
      container.querySelector("#new-ticket-body").value = "ship it";
      container.querySelector("#new-ticket-form").dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );

      await waitFor(() => written(disk).length === 1);
      const [ticket] = written(disk);
      assert.equal(ticket.status, "pending");
      assert.equal(ticket.entries[0].body, "ship it", "body survives the round trip");
      assert.equal(ticket.entries[0].author, "user");
      dispose();
    });

    it("creates the ticket when Enter is pressed in the composer", async () => {
      const { container, disk, dispose } = await mountWithComposer();
      const ta = container.querySelector("#new-ticket-body");
      ta.value = "via enter";
      ta.dispatchEvent(keydown("Enter"));

      await waitFor(() => written(disk).length === 1);
      assert.equal(written(disk)[0].entries[0].body, "via enter");
      dispose();
    });

    it("leaves Shift+Enter to insert a newline", async () => {
      const { container, disk, dispose } = await mountWithComposer();
      const ta = container.querySelector("#new-ticket-body");
      ta.value = "not yet";
      ta.dispatchEvent(keydown("Enter", { shiftKey: true }));

      await sleep(80);
      assert.equal(written(disk).length, 0, "no ticket written");
      dispose();
    });

    it("ignores an empty composer", async () => {
      const { container, disk, dispose } = await mountWithComposer();
      container.querySelector("#new-ticket-body").value = "   ";
      container.querySelector("#new-ticket-form").dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );

      await sleep(80);
      assert.equal(written(disk).length, 0, "whitespace is not a request");
      dispose();
    });

    /* The board is polled every 5s, so a read is usually in flight when the
       user submits. That response was captured before the ticket existed, and
       rendering it drops the brand new card out of pending until the next
       poll — the "cards don't always show up" report. */
    it("keeps the new card when a read from before it lands late", async () => {
      dom.store.clear();
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      let boardReads = 0;
      const ctx = hostWithStore({
        home,
        files: {
          [`${root}/index.json`]: { workspaces: [workspace] },
          [boardPath]: { version: 1, workspace_id: "w1", tickets: [] },
        },
        beforeRead: async (target) => {
          if (target === boardPath && ++boardReads === 1) await held;
        },
      });
      const container = makeContainer();
      const dispose = mountBoard({
        container, path: "demo", navigate: () => {}, host: ctx.host,
      });

      try {
        await waitFor(() => boardReads >= 1);
        container.querySelector("#new-ticket-body").value = "ship it";
        container.querySelector("#new-ticket-form").dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        );

        const pending = () =>
          container.querySelector('.col-cards[data-status="pending"]').textContent;
        await waitFor(() => written(ctx.disk).length === 1);
        await waitFor(() => pending().includes("ship it"));

        release();
        await sleep(80);
        assert.match(pending(), /ship it/, "the card is still in pending");
      } finally {
        // Without this a failure leaves the poll timer holding the runner open.
        release();
        dispose();
      }
    });
  });
});

/* The manager control is the only part of the board that writes to the
   automation backend, and "no manager yet" is the state a fresh install is in
   — so these drive it end to end: the orange offer, the tarball upload, the
   created automation landing on the workspace, and stopping it again. */
describe("manager control", () => {
  const home = "/home/tester";
  const root = `${home}/.openhands/vibe-manager`;
  const indexPath = `${root}/index.json`;

  function workspace(extra = {}) {
    return {
      id: "w1",
      name: "demo",
      path: "/git/demo",
      max_concurrent: 2,
      push_mode: "main",
      automation_id: null,
      ...extra,
    };
  }

  /* The tarball upload is a raw fetch (the host client would JSON-stringify
     the gzip bytes), so the backend registry Canvas keeps in localStorage and
     `fetch` itself are part of the seam. */
  function stubUpload() {
    const uploads = [];
    dom.store.set(
      "openhands-backends",
      JSON.stringify([{ id: "test-backend", host: "https://canvas.example", apiKey: "k" }]),
    );
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      uploads.push({ url: String(url), init });
      return {
        ok: true,
        status: 201,
        json: async () => ({ tarball_path: "oh-internal://uploads/abc" }),
      };
    };
    return { uploads, restore: () => { globalThis.fetch = original; } };
  }

  async function mount(ws, options = {}) {
    dom.store.clear();
    const ctx = hostWithStore({
      home,
      files: {
        [indexPath]: { workspaces: [ws] },
        [`${root}/workspaces/w1/board.json`]: { version: 1, workspace_id: "w1", tickets: [] },
      },
      ...options,
    });
    const container = makeContainer();
    const dispose = mountBoard({ container, path: "demo", navigate: () => {}, host: ctx.host });
    await waitFor(() => !container.querySelector("#mgr-badge").hasAttribute("hidden"));
    return { ...ctx, container, dispose };
  }

  const badgeText = (container) => container.querySelector("#mgr-text").textContent;

  it("offers to start a manager when the workspace has none", async () => {
    const { container, dispose } = await mount(workspace());
    const badge = container.querySelector("#mgr-badge");
    assert.equal(badgeText(container), "Start manager");
    assert.ok(badge.classList.contains("start"), "orange start state");
    assert.equal(
      container.querySelector("#mgr-stop").hasAttribute("hidden"),
      true,
      "nothing to stop yet",
    );
    dispose();
  });

  it("creates the automation and records it on the workspace", async () => {
    const { container, calls, disk, dispose } = await mount(workspace(), {
      createdAutomationId: "auto-9",
    });
    // After the mount: it clears localStorage, where the backend registry lives.
    const upload = stubUpload();
    try {
      container.querySelector("#mgr-badge").dispatchEvent(
        new dom.window.Event("click", { bubbles: true }),
      );
      await waitFor(() => disk.get(indexPath).workspaces[0].automation_id === "auto-9");

      assert.equal(upload.uploads.length, 1, "tarball uploaded once");
      const [{ url, init }] = upload.uploads;
      assert.match(url, /^https:\/\/canvas\.example\/api\/automation\/v1\/uploads\?/);
      assert.equal(init.headers["Content-Type"], "application/gzip");
      assert.ok(init.body instanceof Blob, "the gzip bytes go up as a blob");

      const created = calls.find((c) => c.method === "POST" && c.path === "/api/automation/v1");
      assert.ok(created, "automation created");
      assert.equal(created.body.trigger.schedule, "* * * * *");
      assert.equal(created.body.entrypoint, "python3 main.py");
      assert.equal(created.body.tarball_path, "oh-internal://uploads/abc");
      assert.match(created.body.name, /demo \(w1\)/, "app.py's naming, so it is not duplicated");
    } finally {
      upload.restore();
      dispose();
    }
  });

  it("shows the running manager with a way to stop it", async () => {
    const { container, dispose } = await mount(workspace({ automation_id: "auto-1" }), {
      automations: { "auto-1": { id: "auto-1", enabled: true } },
    });
    await waitFor(() => !container.querySelector("#mgr-stop").hasAttribute("hidden"));
    assert.equal(container.querySelector("#mgr-badge").classList.contains("start"), false);
    dispose();
  });

  it("stopping disables the automation and offers to start it again", async () => {
    const automations = { "auto-1": { id: "auto-1", enabled: true } };
    const { container, calls, dispose } = await mount(
      workspace({ automation_id: "auto-1" }),
      { automations },
    );
    await waitFor(() => !container.querySelector("#mgr-stop").hasAttribute("hidden"));
    container.querySelector("#mgr-stop").dispatchEvent(
      new dom.window.Event("click", { bubbles: true }),
    );

    await waitFor(() => badgeText(container) === "Start manager");
    const patch = calls.find((c) => c.method === "PATCH" && c.path === "/api/automation/v1/auto-1");
    assert.deepEqual(patch.body, { enabled: false });
    assert.equal(automations["auto-1"].enabled, false, "the automation is kept, disabled");
    assert.equal(container.querySelector("#mgr-stop").hasAttribute("hidden"), true);
    dispose();
  });

  it("offers a start when the workspace points at an automation that is gone", async () => {
    const { container, dispose } = await mount(workspace({ automation_id: "auto-gone" }), {
      automations: {},
    });
    await waitFor(() => badgeText(container) === "Start manager");
    dispose();
  });
});

describe("workspace picker", () => {
  /* The store reports a candidate as {path, name} only, so the old
     `${name}${is_git ? "" : " (not git)"}` label tagged every available
     workspace as "not git". Names, nothing else. */
  it("lists candidate workspaces by name alone", async () => {
    dom.store.clear();
    const { host } = hostWithStore({
      workspaces: { workspaceParents: [{ path: "/git" }] },
      subdirs: [{ path: "/git/demo", name: "demo" }],
    });
    const container = makeContainer();
    const dispose = mountBoard({ container, path: "", navigate: () => {}, host });
    await waitFor(() =>
      [...container.querySelectorAll("#workspace-select option")].some(
        (o) => o.getAttribute("value") === "/git/demo",
      ),
    );
    const option = [...container.querySelectorAll("#workspace-select option")].find(
      (o) => o.getAttribute("value") === "/git/demo",
    );
    assert.equal(option.textContent, "demo");
    dispose();
  });
});

describe("bundle", () => {
  const source = readFileSync(DIST, "utf8");

  it("is loadable as browser ESM with no bare or remote imports", () => {
    /* An import specifier lives on one line. The pattern must say so: the
       bundle also carries the automation's python sources, whose `import json`
       lines would otherwise pair up with a quote several lines later. */
    const bare = source.match(/^\s*import\s+[^"'\n]*["'][^./][^"'\n]*["']/gm) || [];
    assert.deepEqual(bare, [], "no bare imports");
    assert.equal(/from\s*["']https?:/.test(source), false, "no remote imports");
    assert.equal(/\brequire\(/.test(source), false, "no CJS require");
  });

  it("exports activate", () => {
    assert.match(source, /export\s*\{[\s\S]*?\bactivate\b/);
  });

  it("embeds the stylesheet with every selector scoped", () => {
    // Guards the build's scoping transform: a page-level selector escaping
    // into the bundle would restyle Canvas itself.
    assert.match(source, /\.vibe-ext \{ --vibe-rem/);
    assert.equal(
      /\n(html|body|:root)\s*[,{]/.test(source),
      false,
      "no unscoped page-level selectors",
    );
  });

  it("only registers page ids declared in the manifest", () => {
    const ids = MANIFEST.contributes.pages.map((p) => p.id);
    const registered = [...source.matchAll(/registerPage\(\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(registered.length > 0, "registerPage called with a literal id");
    for (const id of registered) {
      assert.ok(ids.includes(id), `${id} is declared in the manifest`);
    }
  });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeout) throw new Error("waitFor timed out");
    await sleep(10);
  }
}
