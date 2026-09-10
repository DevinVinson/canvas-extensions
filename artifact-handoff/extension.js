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
	let a = r(await t.agentServer.request({ path: "/api/file/home" })), o = `printf '%s' '${e("#!/usr/bin/env python3\n\"\"\"Artifact Handoff v1 store.  Its only input is one base64 JSON request.\"\"\"\n\nfrom __future__ import annotations\n\nimport base64\nimport hashlib\nimport json\nimport os\nimport re\nimport secrets\nimport stat\nimport sys\nimport tempfile\nfrom datetime import datetime, timezone\nfrom pathlib import Path\n\nAPP = Path(\".openhands/apps/artifact-handoff\")\nMAX_BYTES = 4 * 1024 * 1024\nMAX_PREVIEW = 64 * 1024\nMAX_LIST = 200\nMAX_TEXT = 500\nTYPES = {\"handoff\", \"prototype\", \"plan\", \"spec\", \"report\", \"test-report\", \"other\"}\nMODES = {\"snapshot\", \"reference\"}\nID_RE = re.compile(r\"^[a-z0-9][a-z0-9-]{7,79}$\")\nNAME_RE = re.compile(r\"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$\")\n\n\ndef fail(message):\n    raise ValueError(message)\n\n\ndef now():\n    return datetime.now(timezone.utc).isoformat()\n\n\ndef b64(value):\n    return base64.b64encode(json.dumps(value, separators=(\",\", \":\")).encode()).decode()\n\n\ndef emit(value):\n    print(\"ARTIFACT_HANDOFF\\t\" + b64(value))\n\n\ndef home_root():\n    home = Path.cwd().resolve(strict=True)\n    if not home.is_absolute() or home.is_symlink():\n        fail(\"Agent Server home is not a safe real directory\")\n    return home\n\n\ndef checked(parent, *parts, create=False):\n    target = parent.joinpath(*parts)\n    # No existing component may be a symlink, including the root's App ancestors.\n    current = parent\n    for part in parts:\n        if part in {\"\", \".\", \"..\"} or \"/\" in part or \"\\\\\" in part:\n            fail(\"unsafe path component\")\n        current = current / part\n        if current.exists() and current.is_symlink():\n            fail(\"symbolic links are not allowed in the App store\")\n    if target.exists() and target.is_symlink():\n        fail(\"symbolic links are not allowed in the App store\")\n    if create:\n        target.mkdir(parents=True, exist_ok=True, mode=0o700)\n    return target\n\n\ndef root(create=False):\n    home = home_root()\n    base = checked(home, \".openhands\", \"apps\", \"artifact-handoff\", create=create)\n    expected = home / APP\n    if base.resolve() != expected.resolve():\n        fail(\"App store escaped the Agent Server home\")\n    return base\n\n\ndef artifacts(create=False):\n    return checked(root(create), \"artifacts\", create=create)\n\n\ndef regular(path):\n    try:\n        mode = path.lstat().st_mode\n    except FileNotFoundError:\n        return False\n    return stat.S_ISREG(mode) and not path.is_symlink()\n\n\ndef safe_text(value, name, limit=MAX_TEXT):\n    if not isinstance(value, str):\n        fail(f\"{name} must be text\")\n    value = value.strip()\n    if not value or len(value) > limit or \"\\x00\" in value:\n        fail(f\"invalid {name}\")\n    return value\n\n\ndef artifact_id(value):\n    if not isinstance(value, str) or not ID_RE.fullmatch(value):\n        fail(\"invalid artifact id\")\n    return value\n\n\ndef safe_tags(value):\n    if value is None:\n        return []\n    if not isinstance(value, list) or len(value) > 12:\n        fail(\"tags must contain at most 12 values\")\n    return [safe_text(item, \"tag\", 48) for item in value]\n\n\ndef validate_manifest(raw):\n    if not isinstance(raw, dict) or raw.get(\"schema_version\") != 1:\n        fail(\"unsupported or malformed manifest\")\n    result = {\n        key: raw.get(key)\n        for key in (\n            \"schema_version\",\n            \"id\",\n            \"title\",\n            \"summary\",\n            \"type\",\n            \"tags\",\n            \"created_at\",\n            \"producer\",\n            \"originating_skill\",\n            \"workspace_path\",\n            \"conversation_id\",\n            \"storage_mode\",\n            \"source\",\n        )\n    }\n    result[\"id\"] = artifact_id(result[\"id\"])\n    result[\"title\"] = safe_text(result[\"title\"], \"title\")\n    result[\"summary\"] = safe_text(result[\"summary\"], \"summary\")\n    if result[\"type\"] not in TYPES:\n        fail(\"invalid artifact type\")\n    result[\"tags\"] = safe_tags(result[\"tags\"])\n    if not isinstance(result[\"created_at\"], str) or len(result[\"created_at\"]) > 80:\n        fail(\"invalid created timestamp\")\n    result[\"producer\"] = safe_text(result[\"producer\"], \"producer\", 120)\n    if result[\"originating_skill\"] not in {\"handoff\", \"prototype\", \"save-artifact\"}:\n        fail(\"invalid originating skill\")\n    if result[\"storage_mode\"] not in MODES:\n        fail(\"invalid storage mode\")\n    if not isinstance(result[\"source\"], str) or len(result[\"source\"]) > 2048:\n        fail(\"invalid source\")\n    for optional in (\"workspace_path\", \"conversation_id\"):\n        if result[optional] is not None and (\n            not isinstance(result[optional], str) or len(result[optional]) > 1024\n        ):\n            fail(f\"invalid {optional}\")\n    if result[\"storage_mode\"] == \"snapshot\":\n        content = raw.get(\"content\")\n        if not isinstance(content, dict):\n            fail(\"snapshot manifest lacks content\")\n        name = content.get(\"path\")\n        if (\n            not isinstance(name, str)\n            or not name.startswith(\"content/\")\n            or not NAME_RE.fullmatch(name[8:])\n        ):\n            fail(\"unsafe content path\")\n        if (\n            not isinstance(content.get(\"media_type\"), str)\n            or len(content[\"media_type\"]) > 120\n        ):\n            fail(\"invalid media type\")\n        if (\n            not isinstance(content.get(\"bytes\"), int)\n            or not 0 <= content[\"bytes\"] <= MAX_BYTES\n        ):\n            fail(\"invalid snapshot byte size\")\n        if not isinstance(content.get(\"sha256\"), str) or not re.fullmatch(\n            r\"[a-f0-9]{64}\", content[\"sha256\"]\n        ):\n            fail(\"invalid snapshot checksum\")\n        result[\"content\"] = {\n            \"path\": name,\n            \"media_type\": content[\"media_type\"],\n            \"bytes\": content[\"bytes\"],\n            \"sha256\": content[\"sha256\"],\n        }\n        if isinstance(raw.get(\"html_entrypoint\"), dict):\n            result[\"html_entrypoint\"] = {\n                \"path\": result[\"content\"][\"path\"],\n                \"scripts_disabled\": True,\n            }\n    return result\n\n\ndef read_manifest(directory):\n    manifest = directory / \"manifest.json\"\n    if not regular(manifest):\n        fail(\"missing manifest\")\n    if manifest.stat().st_size > 64 * 1024:\n        fail(\"manifest is too large\")\n    return validate_manifest(json.loads(manifest.read_text(\"utf-8\")))\n\n\ndef digest(path):\n    h = hashlib.sha256()\n    with path.open(\"rb\") as stream:\n        for block in iter(lambda: stream.read(1024 * 1024), b\"\"):\n            h.update(block)\n    return h.hexdigest()\n\n\ndef probe():\n    base = root(False)\n    return {\n        \"python\": sys.version.split()[0],\n        \"store_exists\": base.exists(),\n        \"root\": str(base),\n        \"mutated\": False,\n    }\n\n\ndef register(request):\n    mode = request.get(\"storage_mode\")\n    draft = {\n        \"schema_version\": 1,\n        \"id\": request.get(\"id\") or \"ah-\" + secrets.token_hex(12),\n        \"title\": request.get(\"title\"),\n        \"summary\": request.get(\"summary\"),\n        \"type\": request.get(\"type\", \"other\"),\n        \"tags\": request.get(\"tags\", []),\n        \"created_at\": now(),\n        \"producer\": request.get(\"producer\", \"artifact-handoff-plugin/1.0.0\"),\n        \"originating_skill\": request.get(\"originating_skill\", \"save-artifact\"),\n        \"workspace_path\": request.get(\"workspace_path\"),\n        \"conversation_id\": request.get(\"conversation_id\"),\n        \"storage_mode\": mode,\n        \"source\": request.get(\"source\"),\n    }\n    artifact_id(draft[\"id\"])\n    validate_manifest(\n        {\n            **draft,\n            **(\n                {\n                    \"content\": {\n                        \"path\": \"content/x\",\n                        \"media_type\": \"text/plain\",\n                        \"bytes\": 0,\n                        \"sha256\": \"0\" * 64,\n                    }\n                }\n                if mode == \"snapshot\"\n                else {}\n            ),\n        }\n    )\n    store = artifacts(True)\n    destination = checked(store, draft[\"id\"])\n    if destination.exists():\n        fail(\"artifact id already exists\")\n    temporary = Path(tempfile.mkdtemp(prefix=\".pending-\", dir=store))\n    try:\n        if mode == \"snapshot\":\n            source = Path(safe_text(request.get(\"source\"), \"source\", 2048))\n            if not regular(source):\n                fail(\"snapshot source must be a regular non-symlink file\")\n            size = source.stat().st_size\n            if size > MAX_BYTES:\n                fail(\"snapshot exceeds the 4 MiB limit\")\n            filename = request.get(\"filename\") or source.name\n            if not isinstance(filename, str) or not NAME_RE.fullmatch(filename):\n                fail(\"unsafe snapshot filename\")\n            content = checked(temporary, \"content\", create=True) / filename\n            with source.open(\"rb\") as src, content.open(\"xb\") as out:\n                while block := src.read(1024 * 1024):\n                    out.write(block)\n            content.chmod(0o600)\n            draft[\"content\"] = {\n                \"path\": f\"content/{filename}\",\n                \"media_type\": safe_text(\n                    request.get(\"media_type\", \"text/plain\"), \"media type\", 120\n                ),\n                \"bytes\": size,\n                \"sha256\": digest(content),\n            }\n            if request.get(\"html_entrypoint\") is True:\n                draft[\"html_entrypoint\"] = {\n                    \"path\": draft[\"content\"][\"path\"],\n                    \"scripts_disabled\": True,\n                }\n        elif mode != \"reference\":\n            fail(\"storage mode must be snapshot or reference\")\n        manifest = validate_manifest(draft)\n        (temporary / \"manifest.json\").write_text(\n            json.dumps(manifest, indent=2, sort_keys=True) + \"\\n\", \"utf-8\"\n        )\n        (temporary / \"manifest.json\").chmod(0o600)\n        os.replace(temporary, destination)\n        return manifest\n    except Exception:\n        import shutil\n\n        shutil.rmtree(temporary, ignore_errors=True)\n        raise\n\n\ndef listed(request):\n    query = str(request.get(\"query\", \"\")).lower()[:MAX_TEXT]\n    filters = (\n        request.get(\"filters\", {})\n        if isinstance(request.get(\"filters\", {}), dict)\n        else {}\n    )\n    result, invalid = [], []\n    folder = artifacts(False)\n    if not folder.exists():\n        return {\"artifacts\": [], \"invalid\": [], \"truncated\": False}\n    entries = sorted(\n        (item for item in folder.iterdir() if item.is_dir() and not item.is_symlink()),\n        key=lambda item: item.name,\n        reverse=True,\n    )\n    for item in entries[: MAX_LIST + 1]:\n        try:\n            manifest = read_manifest(item)\n            haystack = \" \".join(\n                [manifest[\"title\"], manifest[\"summary\"], *manifest[\"tags\"]]\n            ).lower()\n            if query and query not in haystack:\n                continue\n            if any(\n                value and manifest.get(key) != value\n                for key, value in filters.items()\n                if key\n                in {\"type\", \"originating_skill\", \"storage_mode\", \"workspace_path\"}\n            ):\n                continue\n            if filters.get(\"tag\") and filters[\"tag\"] not in manifest[\"tags\"]:\n                continue\n            result.append(manifest)\n        except Exception as exc:  # noqa: BLE001 - one malformed entry must not hide valid artifacts\n            invalid.append({\"directory\": item.name[:80], \"error\": str(exc)[:160]})\n    result.sort(key=lambda item: item[\"created_at\"], reverse=True)\n    return {\n        \"artifacts\": result[:MAX_LIST],\n        \"invalid\": invalid[:MAX_LIST],\n        \"truncated\": len(entries) > MAX_LIST,\n    }\n\n\ndef get(request):\n    directory = checked(artifacts(False), artifact_id(request.get(\"id\")))\n    manifest = read_manifest(directory)\n    output = {\"manifest\": manifest, \"reference_exists\": None}\n    if manifest[\"storage_mode\"] == \"reference\":\n        output[\"reference_exists\"] = (\n            Path(manifest[\"source\"]).exists()\n            if not re.match(r\"^[a-z][a-z0-9+.-]*://\", manifest[\"source\"], re.IGNORECASE)\n            else None\n        )\n    elif request.get(\"preview\"):\n        path = directory / manifest[\"content\"][\"path\"]\n        if not regular(path):\n            output[\"verification\"] = \"missing\"\n        else:\n            data = path.read_bytes()[: MAX_PREVIEW + 1]\n            output[\"preview\"] = data[:MAX_PREVIEW].decode(\"utf-8\", \"replace\")\n            output[\"preview_truncated\"] = len(data) > MAX_PREVIEW\n    return output\n\n\ndef verify(request):\n    directory = checked(artifacts(False), artifact_id(request.get(\"id\")))\n    manifest = read_manifest(directory)\n    if manifest[\"storage_mode\"] == \"reference\":\n        return {\"status\": \"reference\", \"id\": manifest[\"id\"]}\n    path = directory / manifest[\"content\"][\"path\"]\n    if not regular(path):\n        return {\"status\": \"missing\", \"id\": manifest[\"id\"]}\n    size, actual = path.stat().st_size, digest(path)\n    status = (\n        \"valid\"\n        if size == manifest[\"content\"][\"bytes\"]\n        and actual == manifest[\"content\"][\"sha256\"]\n        else \"corrupt\"\n    )\n    return {\"status\": status, \"id\": manifest[\"id\"], \"bytes\": size, \"sha256\": actual}\n\n\ndef main():\n    try:\n        raw = (\n            base64.b64decode(sys.argv[1], validate=True)\n            if len(sys.argv) == 2\n            else sys.stdin.buffer.read()\n        )\n        request = json.loads(raw.decode(\"utf-8\"))\n        if not isinstance(request, dict):\n            fail(\"request must be an object\")\n        action = request.get(\"action\")\n        handlers = {\n            \"probe\": probe,\n            \"register\": lambda: register(request),\n            \"list\": lambda: listed(request),\n            \"get\": lambda: get(request),\n            \"verify\": lambda: verify(request),\n        }\n        if action not in handlers:\n            fail(\"unknown action\")\n        emit({\"ok\": True, \"data\": handlers[action]()})\n    except Exception as exc:  # noqa: BLE001 - CLI boundary always emits a structured envelope\n        emit({\"ok\": False, \"error\": str(exc)[:500]})\n\n\nif __name__ == \"__main__\":\n    main()\n")}' | (base64 --decode 2>/dev/null || base64 -D) | python3 - '${e(JSON.stringify(i))}'`, s = n((await t.agentServer.request({
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
