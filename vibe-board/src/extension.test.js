/* Tests run against the BUILT bundle (extension.js), not the sources, so
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
const DIST = join(here, "..", "extension.js");
const MANIFEST = JSON.parse(
  readFileSync(join(here, "..", "canvas-extension.json"), "utf8"),
);

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
    extension: { name: "vibe-board", version: "0.1.0", resolvedRef: "test" },
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

function hostWithStore({ home = "/home/tester", files = {}, workspaces = {} } = {}) {
  const calls = [];
  const disk = new Map(Object.entries(files));
  const host = makeHost({
    agentServer: {
      async request({ path, method = "GET", body } = {}) {
        calls.push({ path, method, body });
        if (path === "/api/file/home") return { home };
        if (path === "/api/workspaces") return workspaces;
        if (path.startsWith("/api/file/download")) {
          const target = filePath(path);
          if (!disk.has(target)) {
            const err = new Error(`404 not found: ${target}`);
            err.status = 404;
            throw err;
          }
          return disk.get(target);
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
  });
});

describe("bundle", () => {
  const source = readFileSync(DIST, "utf8");

  it("is loadable as browser ESM with no bare or remote imports", () => {
    const bare = source.match(/^\s*import\s+[^"']*["'][^./][^"']*["']/gm) || [];
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
