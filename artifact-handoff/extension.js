//#region plugin/scripts/artifact_store.py?raw
var e = (e) => btoa(String.fromCharCode(...new TextEncoder().encode(e))), t = (e) => new TextDecoder().decode(Uint8Array.from(atob(e), (e) => e.charCodeAt(0)));
function n(e) {
	let n = String(e ?? "").split(/\r?\n/).find((e) => e.startsWith("ARTIFACT_HANDOFF	"));
	if (!n) throw Error("The Artifact Handoff helper returned no structured result.");
	try {
		return JSON.parse(t(n.slice(17)));
	} catch {
		throw Error("The Artifact Handoff helper returned malformed structured data.");
	}
}
function r(e) {
	let t = typeof e == "string" ? e : e?.home;
	if (typeof t != "string" || !/^\//.test(t) || t.includes("\0")) throw Error("The Agent Server did not return a safe absolute home path.");
	return t.replace(/\/+$/, "");
}
async function i(t, i) {
	if (!t.agentServer) throw Error("This Canvas host does not expose an Agent Server API.");
	let a = r(await t.agentServer.request({ path: "/api/file/home" })), o = `printf '%s' '${e("#!/usr/bin/env python3\n\"\"\"Artifact Handoff v1 store.  Its only input is one base64 JSON request.\"\"\"\nfrom __future__ import annotations\n\nimport base64, hashlib, json, os, re, secrets, stat, sys, tempfile\nfrom datetime import datetime, timezone\nfrom pathlib import Path\n\nAPP = Path(\".openhands/apps/artifact-handoff\")\nMAX_BYTES = 4 * 1024 * 1024\nMAX_PREVIEW = 64 * 1024\nMAX_LIST = 200\nMAX_TEXT = 500\nTYPES = {\"handoff\", \"prototype\", \"plan\", \"spec\", \"report\", \"test-report\", \"other\"}\nMODES = {\"snapshot\", \"reference\"}\nID_RE = re.compile(r\"^[a-z0-9][a-z0-9-]{7,79}$\")\nNAME_RE = re.compile(r\"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$\")\n\ndef fail(message): raise ValueError(message)\ndef now(): return datetime.now(timezone.utc).isoformat()\ndef b64(value): return base64.b64encode(json.dumps(value, separators=(\",\", \":\")).encode()).decode()\ndef emit(value): print(\"ARTIFACT_HANDOFF\\t\" + b64(value))\n\ndef home_root():\n    home = Path.cwd().resolve(strict=True)\n    if not home.is_absolute() or home.is_symlink(): fail(\"Agent Server home is not a safe real directory\")\n    return home\n\ndef checked(parent, *parts, create=False):\n    target = parent.joinpath(*parts)\n    # No existing component may be a symlink, including the root's App ancestors.\n    current = parent\n    for part in parts:\n        if part in {\"\", \".\", \"..\"} or \"/\" in part or \"\\\\\" in part: fail(\"unsafe path component\")\n        current = current / part\n        if current.exists() and current.is_symlink(): fail(\"symbolic links are not allowed in the App store\")\n    if target.exists() and target.is_symlink(): fail(\"symbolic links are not allowed in the App store\")\n    if create: target.mkdir(parents=True, exist_ok=True, mode=0o700)\n    return target\n\ndef root(create=False):\n    home = home_root()\n    base = checked(home, \".openhands\", \"apps\", \"artifact-handoff\", create=create)\n    expected = home / APP\n    if base.resolve() != expected.resolve(): fail(\"App store escaped the Agent Server home\")\n    return base\n\ndef artifacts(create=False): return checked(root(create), \"artifacts\", create=create)\ndef regular(path):\n    try: mode = path.lstat().st_mode\n    except FileNotFoundError: return False\n    return stat.S_ISREG(mode) and not path.is_symlink()\ndef safe_text(value, name, limit=MAX_TEXT):\n    if not isinstance(value, str): fail(f\"{name} must be text\")\n    value = value.strip()\n    if not value or len(value) > limit or \"\\x00\" in value: fail(f\"invalid {name}\")\n    return value\ndef artifact_id(value):\n    if not isinstance(value, str) or not ID_RE.fullmatch(value): fail(\"invalid artifact id\")\n    return value\ndef safe_tags(value):\n    if value is None: return []\n    if not isinstance(value, list) or len(value) > 12: fail(\"tags must contain at most 12 values\")\n    return [safe_text(item, \"tag\", 48) for item in value]\n\ndef validate_manifest(raw):\n    if not isinstance(raw, dict) or raw.get(\"schema_version\") != 1: fail(\"unsupported or malformed manifest\")\n    result = {key: raw.get(key) for key in (\"schema_version\", \"id\", \"title\", \"summary\", \"type\", \"tags\", \"created_at\", \"producer\", \"originating_skill\", \"workspace_path\", \"conversation_id\", \"storage_mode\", \"source\")}\n    result[\"id\"] = artifact_id(result[\"id\"])\n    result[\"title\"] = safe_text(result[\"title\"], \"title\")\n    result[\"summary\"] = safe_text(result[\"summary\"], \"summary\")\n    if result[\"type\"] not in TYPES: fail(\"invalid artifact type\")\n    result[\"tags\"] = safe_tags(result[\"tags\"])\n    if not isinstance(result[\"created_at\"], str) or len(result[\"created_at\"]) > 80: fail(\"invalid created timestamp\")\n    result[\"producer\"] = safe_text(result[\"producer\"], \"producer\", 120)\n    if result[\"originating_skill\"] not in {\"handoff\", \"prototype\", \"save-artifact\"}: fail(\"invalid originating skill\")\n    if result[\"storage_mode\"] not in MODES: fail(\"invalid storage mode\")\n    if not isinstance(result[\"source\"], str) or len(result[\"source\"]) > 2048: fail(\"invalid source\")\n    for optional in (\"workspace_path\", \"conversation_id\"):\n        if result[optional] is not None and (not isinstance(result[optional], str) or len(result[optional]) > 1024): fail(f\"invalid {optional}\")\n    if result[\"storage_mode\"] == \"snapshot\":\n        content = raw.get(\"content\")\n        if not isinstance(content, dict): fail(\"snapshot manifest lacks content\")\n        name = content.get(\"path\")\n        if not isinstance(name, str) or not name.startswith(\"content/\") or not NAME_RE.fullmatch(name[8:]): fail(\"unsafe content path\")\n        if not isinstance(content.get(\"media_type\"), str) or len(content[\"media_type\"]) > 120: fail(\"invalid media type\")\n        if not isinstance(content.get(\"bytes\"), int) or not 0 <= content[\"bytes\"] <= MAX_BYTES: fail(\"invalid snapshot byte size\")\n        if not isinstance(content.get(\"sha256\"), str) or not re.fullmatch(r\"[a-f0-9]{64}\", content[\"sha256\"]): fail(\"invalid snapshot checksum\")\n        result[\"content\"] = {\"path\": name, \"media_type\": content[\"media_type\"], \"bytes\": content[\"bytes\"], \"sha256\": content[\"sha256\"]}\n        if isinstance(raw.get(\"html_entrypoint\"), dict): result[\"html_entrypoint\"] = {\"path\": result[\"content\"][\"path\"], \"scripts_disabled\": True}\n    return result\n\ndef read_manifest(directory):\n    manifest = directory / \"manifest.json\"\n    if not regular(manifest): fail(\"missing manifest\")\n    if manifest.stat().st_size > 64 * 1024: fail(\"manifest is too large\")\n    return validate_manifest(json.loads(manifest.read_text(\"utf-8\")))\n\ndef digest(path):\n    h = hashlib.sha256()\n    with path.open(\"rb\") as stream:\n        for block in iter(lambda: stream.read(1024 * 1024), b\"\"): h.update(block)\n    return h.hexdigest()\n\ndef probe():\n    base = root(False)\n    return {\"python\": sys.version.split()[0], \"store_exists\": base.exists(), \"root\": str(base), \"mutated\": False}\n\ndef register(request):\n    mode = request.get(\"storage_mode\")\n    draft = {\"schema_version\": 1, \"id\": request.get(\"id\") or \"ah-\" + secrets.token_hex(12), \"title\": request.get(\"title\"), \"summary\": request.get(\"summary\"), \"type\": request.get(\"type\", \"other\"), \"tags\": request.get(\"tags\", []), \"created_at\": now(), \"producer\": request.get(\"producer\", \"artifact-handoff-plugin/1.0.0\"), \"originating_skill\": request.get(\"originating_skill\", \"save-artifact\"), \"workspace_path\": request.get(\"workspace_path\"), \"conversation_id\": request.get(\"conversation_id\"), \"storage_mode\": mode, \"source\": request.get(\"source\")}\n    artifact_id(draft[\"id\"]); validate_manifest({**draft, **({\"content\": {\"path\": \"content/x\", \"media_type\": \"text/plain\", \"bytes\": 0, \"sha256\": \"0\" * 64}} if mode == \"snapshot\" else {})})\n    store = artifacts(True)\n    destination = checked(store, draft[\"id\"])\n    if destination.exists(): fail(\"artifact id already exists\")\n    temporary = Path(tempfile.mkdtemp(prefix=\".pending-\", dir=store))\n    try:\n        if mode == \"snapshot\":\n            source = Path(safe_text(request.get(\"source\"), \"source\", 2048))\n            if not regular(source): fail(\"snapshot source must be a regular non-symlink file\")\n            size = source.stat().st_size\n            if size > MAX_BYTES: fail(\"snapshot exceeds the 4 MiB limit\")\n            filename = request.get(\"filename\") or source.name\n            if not isinstance(filename, str) or not NAME_RE.fullmatch(filename): fail(\"unsafe snapshot filename\")\n            content = checked(temporary, \"content\", create=True) / filename\n            with source.open(\"rb\") as src, content.open(\"xb\") as out:\n                while block := src.read(1024 * 1024): out.write(block)\n            content.chmod(0o600)\n            draft[\"content\"] = {\"path\": f\"content/{filename}\", \"media_type\": safe_text(request.get(\"media_type\", \"text/plain\"), \"media type\", 120), \"bytes\": size, \"sha256\": digest(content)}\n            if request.get(\"html_entrypoint\") is True: draft[\"html_entrypoint\"] = {\"path\": draft[\"content\"][\"path\"], \"scripts_disabled\": True}\n        elif mode != \"reference\": fail(\"storage mode must be snapshot or reference\")\n        manifest = validate_manifest(draft)\n        (temporary / \"manifest.json\").write_text(json.dumps(manifest, indent=2, sort_keys=True) + \"\\n\", \"utf-8\")\n        (temporary / \"manifest.json\").chmod(0o600)\n        os.replace(temporary, destination)\n        return manifest\n    except Exception:\n        import shutil; shutil.rmtree(temporary, ignore_errors=True)\n        raise\n\ndef listed(request):\n    query = str(request.get(\"query\", \"\")).lower()[:MAX_TEXT]\n    filters = request.get(\"filters\", {}) if isinstance(request.get(\"filters\", {}), dict) else {}\n    result, invalid = [], []\n    folder = artifacts(False)\n    if not folder.exists(): return {\"artifacts\": [], \"invalid\": [], \"truncated\": False}\n    entries = sorted((item for item in folder.iterdir() if item.is_dir() and not item.is_symlink()), key=lambda item: item.name, reverse=True)\n    for item in entries[:MAX_LIST + 1]:\n        try:\n            manifest = read_manifest(item)\n            haystack = \" \".join([manifest[\"title\"], manifest[\"summary\"], *manifest[\"tags\"]]).lower()\n            if query and query not in haystack: continue\n            if any(value and manifest.get(key) != value for key, value in filters.items() if key in {\"type\", \"originating_skill\", \"storage_mode\", \"workspace_path\"}): continue\n            if filters.get(\"tag\") and filters[\"tag\"] not in manifest[\"tags\"]: continue\n            result.append(manifest)\n        except Exception as exc: invalid.append({\"directory\": item.name[:80], \"error\": str(exc)[:160]})\n    result.sort(key=lambda item: item[\"created_at\"], reverse=True)\n    return {\"artifacts\": result[:MAX_LIST], \"invalid\": invalid[:MAX_LIST], \"truncated\": len(entries) > MAX_LIST}\n\ndef get(request):\n    directory = checked(artifacts(False), artifact_id(request.get(\"id\")))\n    manifest = read_manifest(directory)\n    output = {\"manifest\": manifest, \"reference_exists\": None}\n    if manifest[\"storage_mode\"] == \"reference\": output[\"reference_exists\"] = Path(manifest[\"source\"]).exists() if not re.match(r\"^[a-z][a-z0-9+.-]*://\", manifest[\"source\"], re.I) else None\n    elif request.get(\"preview\"):\n        path = directory / manifest[\"content\"][\"path\"]\n        if not regular(path): output[\"verification\"] = \"missing\"\n        else:\n            data = path.read_bytes()[:MAX_PREVIEW + 1]\n            output[\"preview\"] = data[:MAX_PREVIEW].decode(\"utf-8\", \"replace\")\n            output[\"preview_truncated\"] = len(data) > MAX_PREVIEW\n    return output\n\ndef verify(request):\n    directory = checked(artifacts(False), artifact_id(request.get(\"id\")))\n    manifest = read_manifest(directory)\n    if manifest[\"storage_mode\"] == \"reference\": return {\"status\": \"reference\", \"id\": manifest[\"id\"]}\n    path = directory / manifest[\"content\"][\"path\"]\n    if not regular(path): return {\"status\": \"missing\", \"id\": manifest[\"id\"]}\n    size, actual = path.stat().st_size, digest(path)\n    status = \"valid\" if size == manifest[\"content\"][\"bytes\"] and actual == manifest[\"content\"][\"sha256\"] else \"corrupt\"\n    return {\"status\": status, \"id\": manifest[\"id\"], \"bytes\": size, \"sha256\": actual}\n\ndef main():\n    try:\n        raw = base64.b64decode(sys.argv[1], validate=True) if len(sys.argv) == 2 else sys.stdin.buffer.read()\n        request = json.loads(raw.decode(\"utf-8\"))\n        if not isinstance(request, dict): fail(\"request must be an object\")\n        action = request.get(\"action\")\n        handlers = {\"probe\": probe, \"register\": lambda: register(request), \"list\": lambda: listed(request), \"get\": lambda: get(request), \"verify\": lambda: verify(request)}\n        if action not in handlers: fail(\"unknown action\")\n        emit({\"ok\": True, \"data\": handlers[action]()})\n    except Exception as exc: emit({\"ok\": False, \"error\": str(exc)[:500]})\nif __name__ == \"__main__\": main()\n")}' | (base64 --decode 2>/dev/null || base64 -D) | python3 - '${e(JSON.stringify(i))}'`, s = n((await t.agentServer.request({
		path: "/api/bash/execute_bash_command",
		method: "POST",
		body: {
			command: o,
			cwd: a
		}
	})).stdout);
	if (!s.ok) throw Error(s.error || "Artifact store command failed.");
	return s.data;
}
async function a(e) {
	if (!e.agentServer) return {
		state: "unsupported",
		plugins: []
	};
	try {
		let t = await e.agentServer.request({ path: "/api/plugins/installed" }), n = Array.isArray(t) ? t : t?.plugins;
		if (!Array.isArray(n)) throw Error("malformed plugin response");
		return {
			state: "ok",
			plugins: n.filter((e) => !!e && typeof e.name == "string" && typeof e.source == "string" && typeof e.enabled == "boolean")
		};
	} catch {
		return {
			state: "unsupported",
			plugins: []
		};
	}
}
function o(e) {
	return e.find((e) => e.name === "artifact-handoff");
}
function s(e, t) {
	return `${e}/.openhands/apps/artifact-handoff/artifacts/${t.id}${t.content ? `/${t.content.path}` : "/manifest.json"}`;
}
function c(t, n, r, i) {
	if (!t.source || t.resolved_ref != null && typeof t.resolved_ref != "string" || t.repo_path != null && typeof t.repo_path != "string") throw Error("Installed Plugin coordinates are malformed.");
	let a = s(r, n), o = i.replace(/[<>]/g, "").replace(/\s+/g, " ").trim(), c = `Inspect Artifact Handoff artifact ${n.id} at ${a} before acting.${o ? ` Objective: ${o}` : ""}`.slice(0, 500), l = [{
		source: t.source,
		ref: t.resolved_ref ?? null,
		repo_path: t.repo_path ?? null
	}];
	return `/launch?plugins=${encodeURIComponent(e(JSON.stringify(l)))}&message=${encodeURIComponent(c)}`;
}
//#endregion
//#region src/extension.ts
var l = "artifacts", u = "/extensions/artifact-handoff/artifacts", d = (e, t = "", n = "") => {
	let r = document.createElement(e);
	return r.textContent = t, r.className = n, r;
}, f = (e, t) => {
	let n = d("button", e);
	return n.type = "button", n.addEventListener("click", t), n;
}, p = class {
	host;
	mount;
	root = document.createElement("main");
	abort = new AbortController();
	home = "";
	plugin;
	artifacts = [];
	constructor(e, t) {
		this.host = e, this.mount = t, this.root.className = "artifact-handoff";
	}
	start() {
		this.mount.container.append(this.root);
		let e = this.mount.path.replace(/^\/+|\/+$/g, "").replace(/^artifacts\//, "");
		return !e || e === "artifacts" ? this.reload() : /^[a-z0-9][a-z0-9-]{7,79}$/.test(e) ? this.detail(e) : this.onboarding("This nested artifact route is invalid."), () => {
			this.abort.abort(), this.root.replaceChildren(), this.root.remove();
		};
	}
	reset(e) {
		this.root.replaceChildren(d("header", "ARTIFACT HANDOFF", "eyebrow"), d("h1", e), d("p", "A small, durable library for work an agent should be able to pick up later.", "lede"));
	}
	async reload() {
		this.reset("Artifacts"), this.root.append(d("p", "Checking the local store and companion Plugin…", "status"));
		try {
			if (!this.host.agentServer || this.host.backend?.kind === "cloud") return this.onboarding("This App needs a local Agent Server; cloud backends do not expose this durable store.");
			let e = await this.host.agentServer.request({ path: "/api/file/home" });
			if (this.home = typeof e == "string" ? e : String(e.home ?? ""), !/^\//.test(this.home)) throw Error("Agent Server home is unavailable.");
			let [t, n] = await Promise.all([i(this.host, { action: "probe" }), a(this.host)]);
			if (this.plugin = o(n.plugins), n.state === "unsupported") return this.onboarding("The Plugin management API is unavailable on this host. The artifact store can still be inspected when Python is available.");
			if (!this.plugin) return this.onboarding(`The Artifact Handoff Plugin is not installed. The store probe was non-mutating (${t.root}).`);
			if (!this.plugin.enabled) return this.onboarding("The Artifact Handoff Plugin is installed but disabled. Enable it separately, then begin a fresh conversation so its skills load.");
			let r = await i(this.host, { action: "list" });
			this.artifacts = r.artifacts, this.library(r.invalid, r.truncated);
		} catch (e) {
			this.onboarding(e instanceof Error ? e.message : "The store probe failed.");
		}
	}
	onboarding(e) {
		this.reset("Ready when you are"), this.root.append(d("p", e, "warning"));
		let t = d("section", "", "card");
		t.append(d("h2", "Two deliberate trust actions"), d("p", "Install this Canvas App and the companion OpenHands Plugin separately. Both begin disabled; this App never installs or enables the Plugin."), d("code", "artifact-handoff/plugin"), d("p", "Ask an OpenHands agent: Install the local Artifact Handoff Plugin from artifact-handoff/plugin, leave it disabled, then tell me how to enable it. Do not install packages or enable it automatically.")), this.root.append(t, f("Recheck readiness", () => void this.reload()));
	}
	library(e, t) {
		this.reset("Artifacts");
		let n = document.createElement("div");
		n.className = "controls";
		let r = document.createElement("input");
		r.placeholder = "Search title, summary, or tag", r.setAttribute("aria-label", "Search artifacts");
		let i = document.createElement("select");
		i.setAttribute("aria-label", "Filter artifact type"), i.append(new Option("All types", ""), ...[...new Set(this.artifacts.map((e) => e.type))].sort().map((e) => new Option(e, e)));
		let a = document.createElement("select");
		a.setAttribute("aria-label", "Filter originating skill"), a.append(new Option("All skills", ""), ...[...new Set(this.artifacts.map((e) => e.originating_skill))].sort().map((e) => new Option(e, e)));
		let o = document.createElement("select");
		o.setAttribute("aria-label", "Filter storage mode"), o.append(new Option("All storage", ""), new Option("snapshot", "snapshot"), new Option("reference", "reference"));
		let s = document.createElement("section");
		s.className = "library";
		let c = () => {
			s.replaceChildren();
			let e = r.value.toLowerCase().trim(), t = this.artifacts.filter((t) => (!e || [
				t.title,
				t.summary,
				...t.tags
			].join(" ").toLowerCase().includes(e)) && (!i.value || t.type === i.value) && (!a.value || t.originating_skill === a.value) && (!o.value || t.storage_mode === o.value));
			t.length || s.append(d("p", "No artifacts match this view.", "empty"));
			for (let e of t) {
				let t = d("article", "", "artifact-card");
				t.append(d("span", `${e.type} · ${e.storage_mode}`, "badge"), d("h2", e.title), d("p", e.summary), d("small", `${e.originating_skill} · ${e.created_at}`), f("Open artifact", () => this.mount.navigate(`${u}/${e.id}`))), s.append(t);
			}
		};
		r.addEventListener("input", c, { signal: this.abort.signal });
		for (let e of [
			i,
			a,
			o
		]) e.addEventListener("change", c, { signal: this.abort.signal });
		n.append(r, i, a, o, f("Reload", () => void this.reload())), this.root.append(n), e.length && this.root.append(d("p", `${e.length} invalid artifact manifest(s) were skipped without hiding valid artifacts.`, "warning")), t && this.root.append(d("p", "List capped at 200 artifacts.", "warning")), this.root.append(s), c();
	}
	async detail(e) {
		this.reset("Artifact detail"), this.root.append(d("p", "Loading validated artifact metadata…", "status"));
		try {
			let t = await i(this.host, {
				action: "get",
				id: e,
				preview: !0
			}), n = t.manifest;
			this.reset(n.title), this.root.append(d("p", n.summary, "lede"));
			let r = d("section", "", "card");
			if (r.append(d("p", `ID: ${n.id}`), d("p", `Origin: ${n.originating_skill} · ${n.producer}`), d("p", `Mode: ${n.storage_mode}`), d("p", `Source: ${n.source}`), d("p", `Stored path: ${s(this.home, n)}`)), t.reference_exists === !1 && r.append(d("p", "Local reference is stale; it was never read automatically.", "warning")), this.root.append(r), n.content && t.preview !== void 0) {
				if (n.html_entrypoint && n.content.media_type === "text/html") {
					let e = document.createElement("iframe");
					e.sandbox.value = "", e.title = "Static prototype preview; scripts disabled", e.srcdoc = t.preview, e.className = "preview-frame", this.root.append(d("p", "Static prototype preview — interactive scripts are disabled.", "warning"), e);
				} else {
					let e = d("pre", t.preview, "preview");
					this.root.append(e), t.preview_truncated && this.root.append(d("p", "Preview truncated at 64 KiB.", "warning"));
				}
			}
			let a = d("section", "", "reuse card");
			a.append(d("h2", "Reuse this artifact"));
			let o = document.createElement("input");
			o.maxLength = 250, o.placeholder = "Short objective for the new conversation", o.setAttribute("aria-label", "Reuse objective"), a.append(o, f("Start conversation with artifact", () => {
				if (!this.plugin) return this.onboarding("Install and enable the companion Plugin before reuse.");
				this.mount.navigate(c(this.plugin, n, this.home, o.value));
			})), this.root.append(a, f("Back to library", () => this.mount.navigate(u)));
		} catch (e) {
			this.onboarding(e instanceof Error ? e.message : "Unable to load artifact.");
		}
	}
};
function m(e) {
	if (e.apiVersion !== "1") throw Error(`Artifact Handoff requires Canvas host API 1, received ${e.apiVersion}.`);
	let t = e.registerPage(l, (t) => new p(e, t).start());
	return () => t();
}
var h = { page: l };
//#endregion
export { u as ARTIFACTS_ROUTE, h as __testing, m as activate };
