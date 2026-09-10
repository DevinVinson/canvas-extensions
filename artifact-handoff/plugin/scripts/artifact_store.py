#!/usr/bin/env python3
"""Artifact Handoff v1 store.  Its only input is one base64 JSON request."""
from __future__ import annotations

import base64, hashlib, json, os, re, secrets, stat, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path

APP = Path(".openhands/apps/artifact-handoff")
MAX_BYTES = 4 * 1024 * 1024
MAX_PREVIEW = 64 * 1024
MAX_LIST = 200
MAX_TEXT = 500
TYPES = {"handoff", "prototype", "plan", "spec", "report", "test-report", "other"}
MODES = {"snapshot", "reference"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{7,79}$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")

def fail(message): raise ValueError(message)
def now(): return datetime.now(timezone.utc).isoformat()
def b64(value): return base64.b64encode(json.dumps(value, separators=(",", ":")).encode()).decode()
def emit(value): print("ARTIFACT_HANDOFF\t" + b64(value))

def home_root():
    home = Path.cwd().resolve(strict=True)
    if not home.is_absolute() or home.is_symlink(): fail("Agent Server home is not a safe real directory")
    return home

def checked(parent, *parts, create=False):
    target = parent.joinpath(*parts)
    # No existing component may be a symlink, including the root's App ancestors.
    current = parent
    for part in parts:
        if part in {"", ".", ".."} or "/" in part or "\\" in part: fail("unsafe path component")
        current = current / part
        if current.exists() and current.is_symlink(): fail("symbolic links are not allowed in the App store")
    if target.exists() and target.is_symlink(): fail("symbolic links are not allowed in the App store")
    if create: target.mkdir(parents=True, exist_ok=True, mode=0o700)
    return target

def root(create=False):
    home = home_root()
    base = checked(home, ".openhands", "apps", "artifact-handoff", create=create)
    expected = home / APP
    if base.resolve() != expected.resolve(): fail("App store escaped the Agent Server home")
    return base

def artifacts(create=False): return checked(root(create), "artifacts", create=create)
def regular(path):
    try: mode = path.lstat().st_mode
    except FileNotFoundError: return False
    return stat.S_ISREG(mode) and not path.is_symlink()
def safe_text(value, name, limit=MAX_TEXT):
    if not isinstance(value, str): fail(f"{name} must be text")
    value = value.strip()
    if not value or len(value) > limit or "\x00" in value: fail(f"invalid {name}")
    return value
def artifact_id(value):
    if not isinstance(value, str) or not ID_RE.fullmatch(value): fail("invalid artifact id")
    return value
def safe_tags(value):
    if value is None: return []
    if not isinstance(value, list) or len(value) > 12: fail("tags must contain at most 12 values")
    return [safe_text(item, "tag", 48) for item in value]

def validate_manifest(raw):
    if not isinstance(raw, dict) or raw.get("schema_version") != 1: fail("unsupported or malformed manifest")
    result = {key: raw.get(key) for key in ("schema_version", "id", "title", "summary", "type", "tags", "created_at", "producer", "originating_skill", "workspace_path", "conversation_id", "storage_mode", "source")}
    result["id"] = artifact_id(result["id"])
    result["title"] = safe_text(result["title"], "title")
    result["summary"] = safe_text(result["summary"], "summary")
    if result["type"] not in TYPES: fail("invalid artifact type")
    result["tags"] = safe_tags(result["tags"])
    if not isinstance(result["created_at"], str) or len(result["created_at"]) > 80: fail("invalid created timestamp")
    result["producer"] = safe_text(result["producer"], "producer", 120)
    if result["originating_skill"] not in {"handoff", "prototype", "save-artifact"}: fail("invalid originating skill")
    if result["storage_mode"] not in MODES: fail("invalid storage mode")
    if not isinstance(result["source"], str) or len(result["source"]) > 2048: fail("invalid source")
    for optional in ("workspace_path", "conversation_id"):
        if result[optional] is not None and (not isinstance(result[optional], str) or len(result[optional]) > 1024): fail(f"invalid {optional}")
    if result["storage_mode"] == "snapshot":
        content = raw.get("content")
        if not isinstance(content, dict): fail("snapshot manifest lacks content")
        name = content.get("path")
        if not isinstance(name, str) or not name.startswith("content/") or not NAME_RE.fullmatch(name[8:]): fail("unsafe content path")
        if not isinstance(content.get("media_type"), str) or len(content["media_type"]) > 120: fail("invalid media type")
        if not isinstance(content.get("bytes"), int) or not 0 <= content["bytes"] <= MAX_BYTES: fail("invalid snapshot byte size")
        if not isinstance(content.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", content["sha256"]): fail("invalid snapshot checksum")
        result["content"] = {"path": name, "media_type": content["media_type"], "bytes": content["bytes"], "sha256": content["sha256"]}
        if isinstance(raw.get("html_entrypoint"), dict): result["html_entrypoint"] = {"path": result["content"]["path"], "scripts_disabled": True}
    return result

def read_manifest(directory):
    manifest = directory / "manifest.json"
    if not regular(manifest): fail("missing manifest")
    if manifest.stat().st_size > 64 * 1024: fail("manifest is too large")
    return validate_manifest(json.loads(manifest.read_text("utf-8")))

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""): h.update(block)
    return h.hexdigest()

def probe():
    base = root(False)
    return {"python": sys.version.split()[0], "store_exists": base.exists(), "root": str(base), "mutated": False}

def register(request):
    mode = request.get("storage_mode")
    draft = {"schema_version": 1, "id": request.get("id") or "ah-" + secrets.token_hex(12), "title": request.get("title"), "summary": request.get("summary"), "type": request.get("type", "other"), "tags": request.get("tags", []), "created_at": now(), "producer": request.get("producer", "artifact-handoff-plugin/1.0.0"), "originating_skill": request.get("originating_skill", "save-artifact"), "workspace_path": request.get("workspace_path"), "conversation_id": request.get("conversation_id"), "storage_mode": mode, "source": request.get("source")}
    artifact_id(draft["id"]); validate_manifest({**draft, **({"content": {"path": "content/x", "media_type": "text/plain", "bytes": 0, "sha256": "0" * 64}} if mode == "snapshot" else {})})
    store = artifacts(True)
    destination = checked(store, draft["id"])
    if destination.exists(): fail("artifact id already exists")
    temporary = Path(tempfile.mkdtemp(prefix=".pending-", dir=store))
    try:
        if mode == "snapshot":
            source = Path(safe_text(request.get("source"), "source", 2048))
            if not regular(source): fail("snapshot source must be a regular non-symlink file")
            size = source.stat().st_size
            if size > MAX_BYTES: fail("snapshot exceeds the 4 MiB limit")
            filename = request.get("filename") or source.name
            if not isinstance(filename, str) or not NAME_RE.fullmatch(filename): fail("unsafe snapshot filename")
            content = checked(temporary, "content", create=True) / filename
            with source.open("rb") as src, content.open("xb") as out:
                while block := src.read(1024 * 1024): out.write(block)
            content.chmod(0o600)
            draft["content"] = {"path": f"content/{filename}", "media_type": safe_text(request.get("media_type", "text/plain"), "media type", 120), "bytes": size, "sha256": digest(content)}
            if request.get("html_entrypoint") is True: draft["html_entrypoint"] = {"path": draft["content"]["path"], "scripts_disabled": True}
        elif mode != "reference": fail("storage mode must be snapshot or reference")
        manifest = validate_manifest(draft)
        (temporary / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", "utf-8")
        (temporary / "manifest.json").chmod(0o600)
        os.replace(temporary, destination)
        return manifest
    except Exception:
        import shutil; shutil.rmtree(temporary, ignore_errors=True)
        raise

def listed(request):
    query = str(request.get("query", "")).lower()[:MAX_TEXT]
    filters = request.get("filters", {}) if isinstance(request.get("filters", {}), dict) else {}
    result, invalid = [], []
    folder = artifacts(False)
    if not folder.exists(): return {"artifacts": [], "invalid": [], "truncated": False}
    entries = sorted((item for item in folder.iterdir() if item.is_dir() and not item.is_symlink()), key=lambda item: item.name, reverse=True)
    for item in entries[:MAX_LIST + 1]:
        try:
            manifest = read_manifest(item)
            haystack = " ".join([manifest["title"], manifest["summary"], *manifest["tags"]]).lower()
            if query and query not in haystack: continue
            if any(value and manifest.get(key) != value for key, value in filters.items() if key in {"type", "originating_skill", "storage_mode", "workspace_path"}): continue
            if filters.get("tag") and filters["tag"] not in manifest["tags"]: continue
            result.append(manifest)
        except Exception as exc: invalid.append({"directory": item.name[:80], "error": str(exc)[:160]})
    result.sort(key=lambda item: item["created_at"], reverse=True)
    return {"artifacts": result[:MAX_LIST], "invalid": invalid[:MAX_LIST], "truncated": len(entries) > MAX_LIST}

def get(request):
    directory = checked(artifacts(False), artifact_id(request.get("id")))
    manifest = read_manifest(directory)
    output = {"manifest": manifest, "reference_exists": None}
    if manifest["storage_mode"] == "reference": output["reference_exists"] = Path(manifest["source"]).exists() if not re.match(r"^[a-z][a-z0-9+.-]*://", manifest["source"], re.I) else None
    elif request.get("preview"):
        path = directory / manifest["content"]["path"]
        if not regular(path): output["verification"] = "missing"
        else:
            data = path.read_bytes()[:MAX_PREVIEW + 1]
            output["preview"] = data[:MAX_PREVIEW].decode("utf-8", "replace")
            output["preview_truncated"] = len(data) > MAX_PREVIEW
    return output

def verify(request):
    directory = checked(artifacts(False), artifact_id(request.get("id")))
    manifest = read_manifest(directory)
    if manifest["storage_mode"] == "reference": return {"status": "reference", "id": manifest["id"]}
    path = directory / manifest["content"]["path"]
    if not regular(path): return {"status": "missing", "id": manifest["id"]}
    size, actual = path.stat().st_size, digest(path)
    status = "valid" if size == manifest["content"]["bytes"] and actual == manifest["content"]["sha256"] else "corrupt"
    return {"status": status, "id": manifest["id"], "bytes": size, "sha256": actual}

def main():
    try:
        raw = base64.b64decode(sys.argv[1], validate=True) if len(sys.argv) == 2 else sys.stdin.buffer.read()
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict): fail("request must be an object")
        action = request.get("action")
        handlers = {"probe": probe, "register": lambda: register(request), "list": lambda: listed(request), "get": lambda: get(request), "verify": lambda: verify(request)}
        if action not in handlers: fail("unknown action")
        emit({"ok": True, "data": handlers[action]()})
    except Exception as exc: emit({"ok": False, "error": str(exc)[:500]})
if __name__ == "__main__": main()
