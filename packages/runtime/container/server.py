from __future__ import annotations

import base64
import errno
import heapq
import hashlib
import io
import json
import mimetypes
import os
import pty
import pwd
import re
import select
import shlex
import shutil
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import tarfile
import tempfile
import termios
import threading
import uuid
import fcntl
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path, PurePosixPath
from typing import Optional
from urllib.parse import parse_qs, quote, unquote, urlparse

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
ROOT = Path("/workspace/sessions")
CLAUDE_CHUNK_DIR = Path("/opt/claude-code/chunks")
CLAUDE_BIN = Path("/tmp/claude-code/claude")
CLAUDE_VERSION = "2.1.197"
CODEX_BIN = Path("/usr/local/bin/codex")
CODEX_VERSION = "0.39.0"
CODEX_MODEL = os.environ.get("CODEX_MODEL", "gpt-5.1-codex")
CODEX_BASE_URL = os.environ.get("CODEX_BASE_URL", "https://yunwu.ai/v1")
CODEX_PROVIDER = os.environ.get("CODEX_PROVIDER", "yunwu")
CLAUDE_LOCK = threading.Lock()
RUNTIME_USER = "appuser"
_RUNTIME_USER_INFO = None
DEFAULT_TERMINAL_ROWS = 30
DEFAULT_TERMINAL_COLS = 120
MIN_TERMINAL_ROWS = 5
MAX_TERMINAL_ROWS = 80
MIN_TERMINAL_COLS = 20
MAX_TERMINAL_COLS = 240
AGENTS = {"claude", "codex"}
ARCHIVE_FORMAT = "2"
ARCHIVE_EXCLUDED_DIR_NAMES = {
    ".cache",
    ".npm",
    ".pnpm-store",
    ".pytest_cache",
    ".turbo",
    "__pycache__",
    "node_modules",
}
ARCHIVE_EXCLUDED_PATHS = {
    (".next", "cache"),
    (".yarn", "cache"),
}
ARCHIVE_IO_CHUNK_BYTES = 1024 * 1024
MAX_SAFE_INTEGER = 9007199254740991


class RuntimeOperationError(Exception):
    def __init__(
        self, code: str, stage: str, message: str, status: int = 500, details=None
    ):
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.status = status
        self.details = details or {}


IGNORED_WORKSPACE_DIRS = {
    ".git",
    ".next",
    ".output",
    ".turbo",
    ".cache",
    "node_modules",
    "coverage",
}
MAX_DIRECTORY_ENTRIES = 500
MAX_STATUS_ENTRIES = 20000
MAX_WORKSPACE_FILE_PATH_LENGTH = 1024
MAX_TEXT_PREVIEW_BYTES = 1024 * 1024
MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024
MAX_PDF_PREVIEW_BYTES = 20 * 1024 * 1024
TEXT_PREVIEW_SUFFIXES = {
    "",
    ".c",
    ".cc",
    ".conf",
    ".cpp",
    ".cs",
    ".css",
    ".csv",
    ".env.example",
    ".go",
    ".graphql",
    ".h",
    ".hpp",
    ".ini",
    ".java",
    ".js",
    ".jsx",
    ".json",
    ".jsonc",
    ".kt",
    ".less",
    ".log",
    ".lua",
    ".mjs",
    ".php",
    ".properties",
    ".py",
    ".rb",
    ".rs",
    ".sass",
    ".scss",
    ".sh",
    ".sql",
    ".svelte",
    ".swift",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".vue",
    ".xml",
    ".yaml",
    ".yml",
}
MARKDOWN_PREVIEW_SUFFIXES = {".md", ".markdown", ".mdx"}
HTML_PREVIEW_SUFFIXES = {".htm", ".html"}
IMAGE_PREVIEW_TYPES = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
SENSITIVE_WORKSPACE_NAMES = {
    "credentials.json",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
}
SENSITIVE_WORKSPACE_SUFFIXES = {".key", ".p12", ".pfx", ".pem"}


class WorkspacePreviewError(Exception):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code = code
        self.status = status


def safe_name(raw: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]", "_", raw)[:80] or "default"


def safe_agent(raw: Optional[str]) -> str:
    return raw if raw in AGENTS else "claude"


def safe_model(raw: Optional[str], fallback: str = "") -> str:
    model = (raw or "").strip()
    if not model:
        return fallback
    if len(model) > 160:
        return fallback
    if not re.match(r"^[a-zA-Z0-9_.:/@+-]+$", model):
        return fallback
    return model


def session_name(session_id: str, agent: str = "claude") -> str:
    prefix = "cx" if safe_agent(agent) == "codex" else "ca"
    return f"{prefix}_{safe_name(session_id)}"


def session_path(session_id: str) -> Path:
    return ROOT / safe_name(session_id)


def workspace_path(session_id: str, requested_path: str = "") -> tuple[Path, Path]:
    root = session_path(session_id).resolve()
    raw = requested_path or ""
    if "\x00" in raw or Path(raw).is_absolute():
        raise ValueError("invalid workspace path")
    candidate = (root / raw).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("workspace path escapes session root")
    return root, candidate


def workspace_file_parts(requested_path: str) -> list[str]:
    raw = requested_path or ""
    if (
        not raw
        or len(raw) > MAX_WORKSPACE_FILE_PATH_LENGTH
        or "\x00" in raw
        or Path(raw).is_absolute()
    ):
        raise WorkspacePreviewError("invalid_path", 400)

    parts = raw.split("/")
    if any(not part or part in {".", ".."} for part in parts):
        raise WorkspacePreviewError("invalid_path", 400)
    for part in parts:
        lowered = part.lower()
        if (
            should_skip_workspace_name(part, False)
            or lowered in SENSITIVE_WORKSPACE_NAMES
            or Path(lowered).suffix in SENSITIVE_WORKSPACE_SUFFIXES
        ):
            raise WorkspacePreviewError("file_not_available", 404)
    return parts


def open_workspace_file(session_id: str, requested_path: str):
    parts = workspace_file_parts(requested_path)
    root = session_path(session_id)
    root_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    root_flags |= getattr(os, "O_DIRECTORY", 0)
    root_flags |= getattr(os, "O_NOFOLLOW", 0)
    directory_flags = root_flags
    file_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    file_flags |= getattr(os, "O_NOFOLLOW", 0)
    file_flags |= getattr(os, "O_NONBLOCK", 0)

    opened: list[int] = []
    try:
        current_fd = os.open(root, root_flags)
        opened.append(current_fd)
        for part in parts[:-1]:
            current_fd = os.open(part, directory_flags, dir_fd=current_fd)
            opened.append(current_fd)
        file_fd = os.open(parts[-1], file_flags, dir_fd=current_fd)
        opened.append(file_fd)
        stat_result = os.fstat(file_fd)
        if not stat.S_ISREG(stat_result.st_mode):
            raise WorkspacePreviewError("not_a_file", 400)
        return file_fd, stat_result, "/".join(parts), opened
    except WorkspacePreviewError:
        for descriptor in reversed(opened):
            os.close(descriptor)
        raise
    except OSError as error:
        for descriptor in reversed(opened):
            os.close(descriptor)
        if error.errno in {
            errno.ELOOP,
            errno.ENOENT,
            errno.ENOTDIR,
            errno.EACCES,
            errno.EPERM,
        }:
            raise WorkspacePreviewError("file_not_available", 404) from None
        raise WorkspacePreviewError("file_read_failed", 500) from None


def close_workspace_file(opened: list[int]):
    for descriptor in reversed(opened):
        try:
            os.close(descriptor)
        except OSError:
            pass


def workspace_preview_type(filename: str) -> tuple[str, str]:
    suffix = Path(filename).suffix.lower()
    if suffix in MARKDOWN_PREVIEW_SUFFIXES:
        return "markdown", "text/markdown; charset=utf-8"
    if suffix in HTML_PREVIEW_SUFFIXES:
        return "html", "text/html; charset=utf-8"
    if suffix == ".svg":
        return "svg", "image/svg+xml; charset=utf-8"
    if suffix == ".pdf":
        return "pdf", "application/pdf"
    if suffix in IMAGE_PREVIEW_TYPES:
        return "image", IMAGE_PREVIEW_TYPES[suffix]
    if suffix in TEXT_PREVIEW_SUFFIXES:
        guessed, _ = mimetypes.guess_type(filename)
        content_type = guessed or "text/plain"
        if content_type == "application/json" or content_type.startswith("text/"):
            content_type = f"{content_type}; charset=utf-8"
        else:
            content_type = "text/plain; charset=utf-8"
        return "text", content_type
    return "binary", "application/octet-stream"


def workspace_preview_limit(kind: str) -> int:
    if kind == "image":
        return MAX_IMAGE_PREVIEW_BYTES
    if kind == "pdf":
        return MAX_PDF_PREVIEW_BYTES
    return MAX_TEXT_PREVIEW_BYTES


def valid_preview_signature(kind: str, suffix: str, sample: bytes) -> bool:
    if kind == "image":
        if suffix == ".png":
            return sample.startswith(b"\x89PNG\r\n\x1a\n")
        if suffix in {".jpg", ".jpeg"}:
            return sample.startswith(b"\xff\xd8\xff")
        if suffix == ".gif":
            return sample.startswith((b"GIF87a", b"GIF89a"))
        if suffix == ".webp":
            return (
                len(sample) >= 12
                and sample.startswith(b"RIFF")
                and sample[8:12] == b"WEBP"
            )
    if kind == "pdf":
        return sample.startswith(b"%PDF-")
    return True


def decode_workspace_text(data: bytes, truncated: bool) -> str | None:
    if b"\x00" in data[:8192]:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as error:
        if not truncated or error.reason != "unexpected end of data":
            return None
        for trim in range(1, min(4, len(data)) + 1):
            try:
                return data[:-trim].decode("utf-8")
            except UnicodeDecodeError:
                continue
        return None


def workspace_file_etag(stat_result) -> str:
    value = (
        f"{stat_result.st_size}\0{stat_result.st_mtime_ns}\0"
        f"{stat_result.st_ino}"
    ).encode()
    return hashlib.sha256(value).hexdigest()


def workspace_file_preview(session_id: str, requested_path: str):
    file_fd, stat_result, relative_path, opened = open_workspace_file(
        session_id, requested_path
    )
    try:
        name = Path(relative_path).name
        suffix = Path(name).suffix.lower()
        kind, content_type = workspace_preview_type(name)
        limit = workspace_preview_limit(kind)
        too_large = stat_result.st_size > limit
        raw_available = kind in {"image", "pdf", "html", "svg"} and not too_large
        previewable = kind != "binary" and (not too_large or kind in {
            "text",
            "markdown",
            "html",
            "svg",
        })
        content = None
        encoding = None
        truncated = False

        if kind in {"image", "pdf"}:
            sample = os.read(file_fd, 32)
            if not valid_preview_signature(kind, suffix, sample):
                kind = "binary"
                content_type = "application/octet-stream"
                previewable = False
                raw_available = False
                too_large = False
        elif kind in {"text", "markdown", "html", "svg"}:
            data = os.read(file_fd, limit + 1)
            truncated = len(data) > limit or stat_result.st_size > limit
            data = data[:limit]
            decoded = decode_workspace_text(data, truncated)
            if decoded is None:
                kind = "binary"
                content_type = "application/octet-stream"
                previewable = False
                raw_available = False
                too_large = False
                truncated = False
            elif kind == "svg" and "<svg" not in decoded[:4096].lower():
                kind = "text"
                content_type = "text/plain; charset=utf-8"
                previewable = True
                raw_available = False
                content = decoded
                encoding = "utf-8"
            else:
                content = decoded
                encoding = "utf-8"

        return {
            "ok": True,
            "exists": True,
            "path": relative_path,
            "name": name,
            "size": stat_result.st_size,
            "mtime": iso_mtime(stat_result),
            "mimeType": content_type,
            "kind": kind,
            "encoding": encoding,
            "etag": workspace_file_etag(stat_result),
            "previewable": previewable,
            "rawAvailable": raw_available,
            "tooLarge": too_large,
            "truncated": truncated,
            **({"content": content} if content is not None else {}),
        }
    finally:
        close_workspace_file(opened)


def send_workspace_file_headers(
    handler,
    *,
    relative_path: str,
    stat_result,
    content_type: str,
    kind: str,
):
    handler.send_header("content-type", content_type)
    handler.send_header("content-length", str(stat_result.st_size))
    handler.send_header(
        "content-disposition",
        f"inline; filename*=UTF-8''{quote(Path(relative_path).name, safe='')}",
    )
    handler.send_header("etag", f'"{workspace_file_etag(stat_result)}"')
    handler.send_header("cache-control", "private, no-store")
    handler.send_header("x-content-type-options", "nosniff")
    handler.send_header("x-file-path", quote(relative_path, safe="/"))
    handler.send_header("x-file-size", str(stat_result.st_size))
    handler.send_header("x-file-mtime", iso_mtime(stat_result))
    handler.send_header("x-file-preview-kind", kind)
    if kind in {"html", "svg"}:
        handler.send_header(
            "content-security-policy",
            "sandbox; default-src 'none'; img-src data: blob:; "
            "style-src 'unsafe-inline'; font-src data:",
        )


def serve_workspace_file_raw(handler, session_id: str, requested_path: str):
    file_fd, stat_result, relative_path, opened = open_workspace_file(
        session_id, requested_path
    )
    try:
        name = Path(relative_path).name
        suffix = Path(name).suffix.lower()
        kind, content_type = workspace_preview_type(name)
        if kind not in {"image", "pdf", "html", "svg"}:
            raise WorkspacePreviewError("unsupported_file", 415)
        if stat_result.st_size > workspace_preview_limit(kind):
            raise WorkspacePreviewError("file_too_large", 413)

        sample = os.read(file_fd, min(stat_result.st_size, 8192))
        os.lseek(file_fd, 0, os.SEEK_SET)
        if kind in {"image", "pdf"} and not valid_preview_signature(
            kind, suffix, sample
        ):
            raise WorkspacePreviewError("unsupported_file", 415)
        if kind in {"html", "svg"}:
            decoded = decode_workspace_text(sample, stat_result.st_size > len(sample))
            if decoded is None:
                raise WorkspacePreviewError("unsupported_file", 415)
            if kind == "svg" and "<svg" not in decoded.lower():
                raise WorkspacePreviewError("unsupported_file", 415)

        handler.send_response(200)
        send_workspace_file_headers(
            handler,
            relative_path=relative_path,
            stat_result=stat_result,
            content_type=content_type,
            kind=kind,
        )
        handler.end_headers()
        while True:
            chunk = os.read(file_fd, 64 * 1024)
            if not chunk:
                break
            handler.wfile.write(chunk)
    finally:
        close_workspace_file(opened)


def should_skip_workspace_name(name: str, show_hidden: bool) -> bool:
    if name in IGNORED_WORKSPACE_DIRS:
        return True
    return not show_hidden and name.startswith(".")


def iso_mtime(stat_result) -> str:
    return datetime.fromtimestamp(
        stat_result.st_mtime, tz=timezone.utc
    ).isoformat().replace("+00:00", "Z")


def directory_has_children(path: Path, show_hidden: bool) -> bool:
    try:
        with os.scandir(path) as children:
            for child in children:
                if should_skip_workspace_name(child.name, show_hidden):
                    continue
                return True
    except OSError:
        return False
    return False


def directory_entry_sort_key(item):
    try:
        is_directory = item.is_dir(follow_symlinks=False)
    except OSError:
        is_directory = False
    return (not is_directory, item.name.lower())


def list_workspace_directory(
    session_id: str, requested_path: str = "", show_hidden: bool = False
):
    root, directory = workspace_path(session_id, requested_path)
    if not root.exists():
        return {
            "ok": True,
            "session": session_id,
            "exists": False,
            "path": "",
            "entries": [],
            "truncated": False,
        }
    if not directory.exists():
        raise FileNotFoundError("workspace directory not found")
    if not directory.is_dir():
        raise NotADirectoryError("workspace path is not a directory")

    relative = "" if directory == root else directory.relative_to(root).as_posix()
    entries = []
    with os.scandir(directory) as scanned:
        children = heapq.nsmallest(
            MAX_DIRECTORY_ENTRIES + 1,
            (
                child
                for child in scanned
                if not should_skip_workspace_name(child.name, show_hidden)
            ),
            key=directory_entry_sort_key,
        )
    truncated = len(children) > MAX_DIRECTORY_ENTRIES
    for scanned_child in children[:MAX_DIRECTORY_ENTRIES]:
        child = Path(scanned_child.path)
        try:
            stat_result = os.stat(child, follow_symlinks=False)
            if stat.S_ISLNK(stat_result.st_mode):
                continue
            is_directory = stat.S_ISDIR(stat_result.st_mode)
            if not is_directory and not stat.S_ISREG(stat_result.st_mode):
                continue
            resolved = child.resolve()
            if resolved != root and root not in resolved.parents:
                continue
        except (FileNotFoundError, PermissionError, OSError):
            continue

        entries.append(
            {
                "name": child.name,
                "path": child.relative_to(root).as_posix(),
                "type": "directory" if is_directory else "file",
                "size": None if is_directory else stat_result.st_size,
                "mtime": iso_mtime(stat_result),
                "hasChildren": directory_has_children(child, show_hidden)
                if is_directory
                else False,
            }
        )

    return {
        "ok": True,
        "session": session_id,
        "exists": True,
        "path": relative,
        "entries": entries,
        "truncated": truncated,
    }


def workspace_metadata_status(session_id: str, show_hidden: bool = False):
    root, _ = workspace_path(session_id)
    if not root.exists():
        return {
            "ok": True,
            "session": session_id,
            "exists": False,
            "digest": None,
            "entryCount": 0,
            "truncated": False,
        }

    digest_value = 0
    entry_count = 0
    truncated = False
    directories = [root]
    while directories and not truncated:
        current = directories.pop()
        discovered_directories = []
        try:
            with os.scandir(current) as scanned:
                for item in scanned:
                    if should_skip_workspace_name(item.name, show_hidden):
                        continue
                    path = Path(item.path)
                    try:
                        if item.is_symlink():
                            continue
                        resolved = path.resolve()
                        if resolved != root and root not in resolved.parents:
                            continue
                        stat_result = item.stat(follow_symlinks=False)
                        is_directory = item.is_dir(follow_symlinks=False)
                    except OSError:
                        continue
                    relative = path.relative_to(root).as_posix()
                    kind = "d" if is_directory else "f"
                    record = (
                        f"{kind}\0{relative}\0{stat_result.st_size}\0"
                        f"{stat_result.st_mtime_ns}\0"
                    ).encode()
                    digest_value ^= int.from_bytes(
                        hashlib.sha256(record).digest(), "big"
                    )
                    entry_count += 1
                    if entry_count >= MAX_STATUS_ENTRIES:
                        truncated = True
                        break
                    if is_directory:
                        discovered_directories.append(path)
        except OSError:
            continue
        directories.extend(discovered_directories)

    digest = hashlib.sha256(
        f"{entry_count}\0{digest_value:064x}".encode()
    ).hexdigest()

    return {
        "ok": True,
        "session": session_id,
        "exists": True,
        "digest": digest,
        "entryCount": entry_count,
        "truncated": truncated,
    }


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(handler, status: int, data):
    body = json.dumps(data, indent=2, ensure_ascii=False).encode()
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def write_runtime_error(handler, error: Exception, default_stage: str):
    if isinstance(error, RuntimeOperationError):
        status = error.status
        code = error.code
        stage = error.stage
        details = error.details
        message = str(error)
    else:
        status = 500
        code = "runtime_internal_error"
        stage = default_stage
        details = {}
        message = str(error) or "Runtime operation failed"

    payload = {
        "ok": False,
        "error": message,
        "code": code,
        "stage": stage,
        "details": details,
    }
    print(json.dumps({"event": "runtime.operation.failed", **payload}), flush=True)
    write_json(handler, status, payload)


def encode_frame(data: bytes) -> bytes:
    length = len(data)
    if length < 126:
        return bytes([0x82, length]) + data
    if length < 65536:
        return bytes([0x82, 126]) + struct.pack("!H", length) + data
    return bytes([0x82, 127]) + struct.pack("!Q", length) + data


def decode_frame(sock: socket.socket):
    header = sock.recv(2)
    if not header:
        return None
    first, second = header
    opcode = first & 0x0F
    masked = second & 0x80
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", sock.recv(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", sock.recv(8))[0]
    mask = sock.recv(4) if masked else b""
    payload = b""
    while len(payload) < length:
        chunk = sock.recv(length - len(payload))
        if not chunk:
            return None
        payload += chunk
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    if opcode == 8:
        return None
    return payload.decode("utf-8", errors="ignore")


def set_winsize(fd: int, rows: int, cols: int):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def terminal_size(rows, cols):
    try:
        parsed_rows = int(rows)
    except (TypeError, ValueError):
        parsed_rows = DEFAULT_TERMINAL_ROWS
    try:
        parsed_cols = int(cols)
    except (TypeError, ValueError):
        parsed_cols = DEFAULT_TERMINAL_COLS
    return (
        max(MIN_TERMINAL_ROWS, min(MAX_TERMINAL_ROWS, parsed_rows)),
        max(MIN_TERMINAL_COLS, min(MAX_TERMINAL_COLS, parsed_cols)),
    )


def runtime_user_info():
    global _RUNTIME_USER_INFO
    if _RUNTIME_USER_INFO is None:
        _RUNTIME_USER_INFO = pwd.getpwnam(RUNTIME_USER)
    return _RUNTIME_USER_INFO


def runtime_subprocess_kwargs():
    if os.geteuid() != 0:
        return {}
    user = runtime_user_info()
    return {"user": user.pw_uid, "group": user.pw_gid, "extra_groups": []}


def runtime_chown(path: Path):
    if os.geteuid() != 0 or not path.exists():
        return
    user = runtime_user_info()
    targets = [path]
    if path.is_dir():
        targets.extend(path.rglob("*"))
    for target in targets:
        try:
            os.chown(target, user.pw_uid, user.pw_gid)
        except FileNotFoundError:
            pass


def read_json_file(path: Path):
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def write_json_file(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def write_claude_bootstrap(config_dir: Path, home_dir: Path, cwd: Path, base_url: str) -> Path:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    helper = config_dir / "codeagent-api-key-helper.sh"
    helper.write_text(
        "#!/bin/sh\n"
        "printf '%s\\n' \"${CODEAGENT_ANTHROPIC_API_KEY:-}\"\n",
        encoding="utf-8",
    )
    helper.chmod(0o700)

    settings = {
        "$schema": "https://json.schemastore.org/claude-code-settings.json",
        "apiKeyHelper": str(helper),
        "defaultMode": "acceptEdits",
        "skipDangerousModePermissionPrompt": True,
        "theme": "dark",
        "themeName": "dark",
        "themeSetting": "dark",
        "disableArtifact": True,
        "disableRemoteControl": True,
        "env": {
            "ANTHROPIC_BASE_URL": base_url,
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1",
            "DISABLE_AUTOUPDATER": "1",
        },
    }
    settings_path = config_dir / "settings.json"
    write_json_file(settings_path, settings)
    write_json_file(home_dir / ".claude" / "settings.json", settings)

    for state_path in [config_dir / ".claude.json", home_dir / ".claude.json"]:
        state = read_json_file(state_path)
        state.setdefault("firstStartTime", now)
        state.setdefault("machineID", hashlib.sha256(str(config_dir).encode()).hexdigest())
        state.setdefault("seenNotifications", {})
        state.setdefault("migrationVersion", 13)
        state["hasCompletedOnboarding"] = True
        state["lastOnboardingVersion"] = CLAUDE_VERSION
        state["theme"] = "dark"
        state["themeName"] = "dark"
        state["themeSetting"] = "dark"
        projects = state.setdefault("projects", {})
        project = projects.setdefault(str(cwd), {})
        project["hasTrustDialogAccepted"] = True
        project["hasCompletedProjectOnboarding"] = True
        project["projectOnboardingSeenCount"] = 1
        write_json_file(state_path, state)

    return settings_path


def toml_string(value: str) -> str:
    return json.dumps(value)


def codex_base_url(base_url: str) -> str:
    raw = (base_url or CODEX_BASE_URL).strip().rstrip("/")
    if raw.endswith("/v1"):
        return raw
    return f"{raw}/v1"


def write_codex_bootstrap(home_dir: Path, cwd: Path, model: str, base_url: str) -> Path:
    config_dir = home_dir / ".codex"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "config.toml"
    provider = safe_name(CODEX_PROVIDER)
    config_path.write_text(
        f"model = {toml_string(model)}\n"
        f"model_provider = {toml_string(provider)}\n"
        'approval_policy = "on-failure"\n'
        'sandbox_mode = "workspace-write"\n'
        f"[model_providers.{provider}]\n"
        f"name = {toml_string(provider)}\n"
        f"base_url = {toml_string(codex_base_url(base_url))}\n"
        'env_key = "OPENAI_API_KEY"\n'
        'wire_api = "responses"\n'
        "\n"
        f"[projects.{toml_string(str(cwd))}]\n"
        'trust_level = "trusted"\n',
        encoding="utf-8",
    )
    return config_path


def run_tmux(args):
    return subprocess.run(
        ["tmux", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        **runtime_subprocess_kwargs(),
    )


def configure_tmux_session(name: str):
    options = [
        ["set-option", "-t", name, "mouse", "off"],
        ["set-option", "-t", name, "status", "off"],
        ["set-option", "-t", name, "focus-events", "on"],
        ["set-option", "-t", name, "history-limit", "50000"],
        ["set-window-option", "-t", f"{name}:0", "mode-keys", "vi"],
    ]
    for args in options:
        run_tmux(args)


def reset_tmux_interaction_state(name: str):
    run_tmux(["set-option", "-t", name, "mouse", "off"])
    run_tmux(["set-option", "-t", name, "status", "off"])
    run_tmux(["send-keys", "-t", name, "-X", "cancel"])


def install_claude_launcher(home_dir: Path, claude_bin: Path):
    bin_dir = home_dir / ".local" / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    launcher = bin_dir / "claude"
    launcher.write_text(
        "#!/bin/sh\n"
        f"exec {shlex.quote(str(claude_bin))} \"$@\"\n",
        encoding="utf-8",
    )
    launcher.chmod(0o755)


def claude_process_env(
    home_dir: Path,
    config_dir: Path,
    base_url: str,
    model_gateway_token: str,
):
    blocked = {
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
        "CLAUDE_CODE_OAUTH_TOKEN",
    }
    env = {key: value for key, value in os.environ.items() if key not in blocked}
    env.update({
        "HOME": str(home_dir),
        "CLAUDE_CONFIG_DIR": str(config_dir),
        "CODEAGENT_ANTHROPIC_API_KEY": model_gateway_token,
        "ANTHROPIC_BASE_URL": base_url,
        "PATH": f"{home_dir / '.local' / 'bin'}:{env.get('PATH', '')}",
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "DISABLE_AUTOUPDATER": "1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    })
    return env


def codex_process_env(home_dir: Path, openai_api_key: str):
    blocked = {
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
        "CLAUDE_CODE_OAUTH_TOKEN",
    }
    env = {key: value for key, value in os.environ.items() if key not in blocked}
    env.update({
        "HOME": str(home_dir),
        "CODEX_HOME": str(home_dir / ".codex"),
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
    })
    if openai_api_key:
        env["OPENAI_API_KEY"] = openai_api_key
    return env


def ensure_claude_binary() -> Path:
    with CLAUDE_LOCK:
        if CLAUDE_BIN.exists() and os.access(CLAUDE_BIN, os.X_OK):
            return CLAUDE_BIN

        chunks = sorted(CLAUDE_CHUNK_DIR.glob("claude.part.*"))
        if not chunks:
            raise FileNotFoundError(f"Claude Code chunks not found in {CLAUDE_CHUNK_DIR}")

        CLAUDE_BIN.parent.mkdir(parents=True, exist_ok=True)
        tmp = CLAUDE_BIN.with_suffix(".tmp")
        with tmp.open("wb") as output:
            for chunk in chunks:
                output.write(chunk.read_bytes())
        tmp.chmod(0o755)
        tmp.replace(CLAUDE_BIN)
        return CLAUDE_BIN


def ensure_codex_binary() -> Path:
    candidate = shutil.which("codex")
    if candidate:
        return Path(candidate)
    if CODEX_BIN.exists() and os.access(CODEX_BIN, os.X_OK):
        return CODEX_BIN
    raise FileNotFoundError("Codex CLI not found")


def tmux_exists(session_id: str, agent: str = "claude") -> bool:
    return run_tmux(["has-session", "-t", session_name(session_id, agent)]).returncode == 0


def kill_tmux(session_id: str, agent: Optional[str] = None):
    agents = [safe_agent(agent)] if agent else sorted(AGENTS)
    for item in agents:
        name = session_name(session_id, item)
        if run_tmux(["has-session", "-t", name]).returncode == 0:
            run_tmux(["kill-session", "-t", name])


def resize_tmux_window(session_id: str, rows: int, cols: int, agent: str = "claude"):
    name = session_name(session_id, agent)
    if run_tmux(["has-session", "-t", name]).returncode != 0:
        return
    run_tmux(["resize-window", "-t", f"{name}:0", "-x", str(cols), "-y", str(rows)])


def maybe_accept_claude_trust_prompt(name: str):
    def worker():
        for _ in range(40):
            if run_tmux(["has-session", "-t", name]).returncode != 0:
                return
            pane = run_tmux(["capture-pane", "-p", "-t", name, "-S", "-200"])
            text = pane.stdout.lower()
            if "quick safety check" in text or "trust this folder" in text:
                run_tmux(["send-keys", "-t", name, "1", "Enter"])
                return
            if "write tests for @filename" in text or "claude exited" in text:
                return
            threading.Event().wait(0.5)

    threading.Thread(target=worker, daemon=True).start()


def ensure_claude_tmux(
    session_id: str,
    base_url: str,
    model: str,
    model_gateway_token: str,
):
    name = session_name(session_id, "claude")
    cwd = session_path(session_id)
    cwd.mkdir(parents=True, exist_ok=True)
    (cwd / ".codeagent").mkdir(exist_ok=True)
    runtime_chown(cwd)

    if tmux_exists(session_id, "claude"):
        return name, cwd

    config_dir = Path("/tmp/claude-config") / safe_name(session_id)
    home_dir = Path("/tmp/claude-home") / safe_name(session_id)
    config_dir.mkdir(parents=True, exist_ok=True)
    home_dir.mkdir(parents=True, exist_ok=True)
    settings_path = write_claude_bootstrap(config_dir, home_dir, cwd, base_url)
    claude_bin = ensure_claude_binary()
    install_claude_launcher(home_dir, claude_bin)
    runtime_chown(config_dir)
    runtime_chown(home_dir)

    model = safe_model(model)
    inner_command = (
        "printf '[starting claude]\\n'; "
        f"{shlex.quote(str(claude_bin))} --settings {shlex.quote(str(settings_path))}"
        f"{f' --model {shlex.quote(model)}' if model else ''} --permission-mode acceptEdits; "
        "code=$?; printf '\\n[claude exited: %s]\\n' \"$code\"; exec /bin/sh"
    )
    command = f"/bin/sh -lc {shlex.quote(inner_command)}"
    created = subprocess.run([
        "tmux", "new-session", "-d", "-s", name, "-c", str(cwd), command
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=claude_process_env(
        home_dir,
        config_dir,
        base_url,
        model_gateway_token,
    ), **runtime_subprocess_kwargs())
    if created.returncode != 0:
        raise RuntimeError(created.stderr or "failed to create claude tmux session")
    configure_tmux_session(name)
    maybe_accept_claude_trust_prompt(name)
    return name, cwd


def ensure_codex_tmux(session_id: str, openai_api_key: str, model: str, base_url: str):
    name = session_name(session_id, "codex")
    cwd = session_path(session_id)
    cwd.mkdir(parents=True, exist_ok=True)
    (cwd / ".codeagent").mkdir(exist_ok=True)
    runtime_chown(cwd)

    if tmux_exists(session_id, "codex"):
        return name, cwd

    model = safe_model(model, CODEX_MODEL)
    home_dir = Path("/tmp/codex-home") / safe_name(session_id)
    home_dir.mkdir(parents=True, exist_ok=True)
    write_codex_bootstrap(home_dir, cwd, model, base_url)
    codex_bin = ensure_codex_binary()
    runtime_chown(home_dir)

    if not openai_api_key:
        inner_command = (
            "printf '[starting codex]\\n'; "
            "printf 'Missing OPENAI_API_KEY. Configure the runtime Worker secret before starting Codex CLI sessions.\\n'; "
            "exec /bin/sh"
        )
    else:
        inner_command = (
            "printf '[starting codex]\\n'; "
            f"{shlex.quote(str(codex_bin))} --full-auto --model {shlex.quote(model)} -C {shlex.quote(str(cwd))}; "
            "code=$?; printf '\\n[codex exited: %s]\\n' \"$code\"; exec /bin/sh"
        )
    command = f"/bin/sh -lc {shlex.quote(inner_command)}"
    created = subprocess.run([
        "tmux", "new-session", "-d", "-s", name, "-c", str(cwd), command
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=codex_process_env(home_dir, openai_api_key), **runtime_subprocess_kwargs())
    if created.returncode != 0:
        raise RuntimeError(created.stderr or "failed to create codex tmux session")
    configure_tmux_session(name)
    return name, cwd


def ensure_agent_tmux(
    session_id: str,
    base_url: str,
    agent: str,
    model_gateway_token: str,
    model: str,
):
    if safe_agent(agent) == "codex":
        return ensure_codex_tmux(
            session_id,
            model_gateway_token,
            model,
            base_url,
        )
    return ensure_claude_tmux(
        session_id,
        base_url,
        model,
        model_gateway_token,
    )


def archive_path_is_excluded(relative: PurePosixPath) -> bool:
    parts = relative.parts
    if any(part in ARCHIVE_EXCLUDED_DIR_NAMES for part in parts):
        return True
    return any(parts[: len(prefix)] == prefix for prefix in ARCHIVE_EXCLUDED_PATHS)


def archive_max_bytes(parsed):
    values = parse_qs(parsed.query, keep_blank_values=True).get("maxBytes")
    if values is None:
        return None
    if len(values) != 1 or not values[0].isdigit():
        raise RuntimeOperationError(
            "invalid_archive_max_bytes",
            "archive.quota",
            "maxBytes must be a non-negative safe integer",
            400,
        )
    value = int(values[0])
    if value > MAX_SAFE_INTEGER:
        raise RuntimeOperationError(
            "invalid_archive_max_bytes",
            "archive.quota",
            "maxBytes must be a non-negative safe integer",
            400,
        )
    return value


def archive_size_exceeded(max_bytes: int, actual_bytes: int, path: str = ""):
    details = {"maxBytes": max_bytes, "actualBytes": actual_bytes}
    if path:
        details["path"] = path
    return RuntimeOperationError(
        "archive_size_exceeded",
        "archive.quota",
        "Workspace archive exceeds the reserved storage capacity",
        413,
        details,
    )


def snapshot_workspace(
    root: Path,
    stage: str = "workspace.scan",
    max_bytes: Optional[int] = None,
):
    entries = []
    skipped = []
    total_bytes = 0
    if not root.exists():
        return entries, skipped

    def handle_walk_error(error):
        raise RuntimeOperationError(
            "workspace_scan_failed",
            stage,
            f"Failed to scan workspace: {error}",
            details={"path": str(Path(error.filename).name) if error.filename else ""},
        )

    for current, dir_names, file_names in os.walk(
        root, followlinks=False, onerror=handle_walk_error
    ):
        current_path = Path(current)
        kept_dirs = []
        for name in sorted(dir_names):
            path = current_path / name
            relative = PurePosixPath(path.relative_to(root).as_posix())
            if path.is_symlink() or archive_path_is_excluded(relative):
                skipped.append(relative.as_posix())
                continue
            kept_dirs.append(name)
        dir_names[:] = kept_dirs

        for name in sorted(file_names):
            path = current_path / name
            relative = PurePosixPath(path.relative_to(root).as_posix())
            if path.is_symlink() or archive_path_is_excluded(relative):
                skipped.append(relative.as_posix())
                continue
            try:
                stat_result = os.stat(path, follow_symlinks=False)
            except FileNotFoundError:
                skipped.append(relative.as_posix())
                continue
            except OSError as error:
                raise RuntimeOperationError(
                    "workspace_file_read_failed",
                    stage,
                    f"Failed to read workspace file: {relative.as_posix()}",
                    details={"path": relative.as_posix(), "reason": str(error)},
                ) from error
            if not stat.S_ISREG(stat_result.st_mode):
                skipped.append(relative.as_posix())
                continue
            total_bytes += stat_result.st_size
            if max_bytes is not None and total_bytes > max_bytes:
                raise archive_size_exceeded(
                    max_bytes,
                    total_bytes,
                    relative.as_posix(),
                )
            entries.append({
                "path": relative.as_posix(),
                "source": path,
                "size": stat_result.st_size,
                "mode": stat_result.st_mode & 0o777,
                "mtime": int(stat_result.st_mtime),
            })

    entries.sort(key=lambda entry: entry["path"])
    return entries, skipped


def hash_workspace_entry(entry, stage: str) -> str:
    digest = hashlib.sha256()
    bytes_read = 0
    try:
        with entry["source"].open("rb") as source:
            stat_result = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(stat_result.st_mode)
                or stat_result.st_size != entry["size"]
            ):
                raise RuntimeOperationError(
                    "workspace_changed_during_scan",
                    stage,
                    f"Workspace file changed during scan: {entry['path']}",
                    409,
                    {"path": entry["path"]},
                )
            while True:
                chunk = source.read(ARCHIVE_IO_CHUNK_BYTES)
                if not chunk:
                    break
                bytes_read += len(chunk)
                digest.update(chunk)
    except RuntimeOperationError:
        raise
    except FileNotFoundError:
        raise RuntimeOperationError(
            "workspace_changed_during_scan",
            stage,
            f"Workspace file disappeared during scan: {entry['path']}",
            409,
            {"path": entry["path"]},
        ) from None
    except OSError as error:
        raise RuntimeOperationError(
            "workspace_file_read_failed",
            stage,
            f"Failed to read workspace file: {entry['path']}",
            details={"path": entry["path"], "reason": str(error)},
        ) from error
    if bytes_read != entry["size"]:
        raise RuntimeOperationError(
            "workspace_changed_during_scan",
            stage,
            f"Workspace file changed during scan: {entry['path']}",
            409,
            {"path": entry["path"]},
        )
    return digest.hexdigest()


def manifest_from_files(session_id: str, files, skipped=None):
    digest = hashlib.sha256()
    for file in files:
        digest.update(file["path"].encode())
        digest.update(b"\0")
        digest.update(file["sha256"].encode())
        digest.update(b"\0")

    skipped = skipped or []
    return {
        "ok": True,
        "session": session_id,
        "exists": True,
        "digest": digest.hexdigest(),
        "file_count": len(files),
        "total_bytes": sum(file["size"] for file in files),
        "files": files,
        "skipped_count": len(skipped),
        "skipped_files": skipped[:50],
    }


def manifest_from_entries(session_id: str, entries, skipped=None):
    files = []
    for entry in entries:
        files.append({
            "path": entry["path"],
            "size": entry["size"],
            "sha256": hash_workspace_entry(entry, "workspace.inspect"),
        })
    return manifest_from_files(session_id, files, skipped)


def workspace_manifest_for_root(session_id: str, root: Path):
    if not root.exists():
        return {
            "ok": True,
            "session": session_id,
            "exists": False,
            "digest": None,
            "file_count": 0,
            "total_bytes": 0,
            "files": [],
            "skipped_count": 0,
            "skipped_files": [],
        }
    entries, skipped = snapshot_workspace(root, "workspace.inspect")
    return manifest_from_entries(session_id, entries, skipped)


def workspace_manifest(session_id: str):
    return workspace_manifest_for_root(session_id, session_path(session_id))


def seed_workspace(session_id: str):
    root = session_path(session_id)
    if root.exists():
        shutil.rmtree(root)
    (root / "dist" / "assets").mkdir(parents=True, exist_ok=True)
    (root / "README.md").write_text(f"# Integrated session\n\nsession={session_id}\n", encoding="utf-8")
    (root / "dist" / "index.html").write_text("""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Integrated Preview</title>
    <link rel="stylesheet" href="./assets/style.css" />
  </head>
  <body>
    <main>
      <p class="eyebrow">Integrated Session MVP</p>
      <h1>Preview from restored workspace</h1>
      <p id="session">loading</p>
    </main>
    <script src="./assets/app.js"></script>
  </body>
</html>
""", encoding="utf-8")
    (root / "dist" / "assets" / "style.css").write_text("""
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f8fafc; color: #111827; }
main { width: min(680px, calc(100vw - 32px)); padding: 32px; background: white; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 18px 45px rgba(15, 23, 42, .08); }
.eyebrow { color: #2563eb; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 8px 0 12px; font-size: 32px; }
#session { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
""", encoding="utf-8")
    (root / "dist" / "assets" / "app.js").write_text("""
fetch("./api/session")
  .then((response) => response.json())
  .then((data) => {
    document.querySelector("#session").textContent = `user=${data.userId} session=${data.sessionId} runtime=${data.runtime}`;
    });
""", encoding="utf-8")
    runtime_chown(root)
    return workspace_manifest(session_id)


class DigestingReader:
    def __init__(self, source):
        self.source = source
        self.digest = hashlib.sha256()
        self.bytes_read = 0

    def read(self, size=-1):
        chunk = self.source.read(size)
        self.bytes_read += len(chunk)
        self.digest.update(chunk)
        return chunk

    def hexdigest(self):
        return self.digest.hexdigest()


def archive_file_sha256(archive_file) -> str:
    digest = hashlib.sha256()
    archive_file.seek(0)
    while True:
        chunk = archive_file.read(ARCHIVE_IO_CHUNK_BYTES)
        if not chunk:
            break
        digest.update(chunk)
    archive_file.seek(0)
    return digest.hexdigest()


def make_archive(session_id: str, max_bytes: Optional[int] = None):
    root = session_path(session_id)
    if not root.exists():
        raise RuntimeOperationError(
            "workspace_not_found",
            "archive.snapshot",
            f"Workspace not found: {session_id}",
            404,
        )
    entries, skipped = snapshot_workspace(
        root,
        "archive.snapshot",
        max_bytes,
    )
    files = []
    archive_file = tempfile.TemporaryFile(mode="w+b")
    try:
        with tarfile.open(fileobj=archive_file, mode="w:gz") as tar:
            for entry in entries:
                info = tarfile.TarInfo(entry["path"])
                info.size = entry["size"]
                info.mode = entry["mode"]
                info.mtime = entry["mtime"]
                info.uid = 0
                info.gid = 0
                info.uname = ""
                info.gname = ""
                with entry["source"].open("rb") as source:
                    stat_result = os.fstat(source.fileno())
                    if (
                        not stat.S_ISREG(stat_result.st_mode)
                        or stat_result.st_size != entry["size"]
                    ):
                        raise RuntimeOperationError(
                            "workspace_changed_during_archive",
                            "archive.build",
                            "Workspace file changed while building archive",
                            409,
                            {"path": entry["path"]},
                        )
                    digesting_source = DigestingReader(source)
                    tar.addfile(info, digesting_source)
                    if digesting_source.bytes_read != entry["size"]:
                        raise RuntimeOperationError(
                            "workspace_changed_during_archive",
                            "archive.build",
                            "Workspace file changed while building archive",
                            409,
                            {"path": entry["path"]},
                        )
                    files.append({
                        "path": entry["path"],
                        "size": entry["size"],
                        "sha256": digesting_source.hexdigest(),
                    })
        archive_file.flush()
        archive_size = os.fstat(archive_file.fileno()).st_size
        if max_bytes is not None and archive_size > max_bytes:
            raise archive_size_exceeded(max_bytes, archive_size)
        manifest = manifest_from_files(session_id, files, skipped)
        archive_sha256 = archive_file_sha256(archive_file)
        return archive_file, manifest, archive_sha256, archive_size
    except RuntimeOperationError:
        archive_file.close()
        raise
    except Exception as error:
        archive_file.close()
        raise RuntimeOperationError(
            "archive_build_failed",
            "archive.build",
            f"Failed to build workspace archive: {error}",
        ) from error


def safe_archive_member_path(member_name: str) -> PurePosixPath:
    relative = PurePosixPath(member_name)
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        raise RuntimeOperationError(
            "unsafe_archive_path",
            "restore.validate",
            f"Unsafe archive path: {member_name}",
            422,
            {"path": member_name},
        )
    return relative


def restore_archive(
    session_id: str,
    data: bytes,
    expected_workspace_digest: str = "",
    expected_archive_sha256: str = "",
    archive_format: str = "1",
):
    root = session_path(session_id)
    staging = ROOT / f".{safe_name(session_id)}.restore-{uuid.uuid4().hex}"
    backup = ROOT / f".{safe_name(session_id)}.backup-{uuid.uuid4().hex}"

    actual_archive_sha256 = sha256_bytes(data)
    if expected_archive_sha256 and actual_archive_sha256 != expected_archive_sha256:
        raise RuntimeOperationError(
            "archive_checksum_mismatch",
            "restore.validate",
            "Archive checksum does not match R2 metadata",
            409,
            {
                "expectedArchiveSha256": expected_archive_sha256,
                "actualArchiveSha256": actual_archive_sha256,
            },
        )

    try:
        staging.mkdir(parents=True, exist_ok=False)
        try:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
                for member in tar.getmembers():
                    relative = safe_archive_member_path(member.name)
                    if member.isdir():
                        (staging.joinpath(*relative.parts)).mkdir(
                            parents=True, exist_ok=True
                        )
                        continue
                    if not member.isfile():
                        raise RuntimeOperationError(
                            "unsupported_archive_entry",
                            "restore.validate",
                            f"Unsupported archive entry: {member.name}",
                            422,
                            {
                                "path": member.name,
                                "type": member.type.decode(errors="ignore"),
                            },
                        )
                    source = tar.extractfile(member)
                    if source is None:
                        raise RuntimeOperationError(
                            "archive_entry_unreadable",
                            "restore.extract",
                            f"Archive entry cannot be read: {member.name}",
                            422,
                            {"path": member.name},
                        )
                    target = staging.joinpath(*relative.parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with source, target.open("wb") as output:
                        shutil.copyfileobj(source, output)
                    target.chmod(member.mode & 0o777)
        except RuntimeOperationError:
            raise
        except (tarfile.TarError, OSError) as error:
            raise RuntimeOperationError(
                "archive_extract_failed",
                "restore.extract",
                f"Failed to extract workspace archive: {error}",
                422,
            ) from error

        manifest = workspace_manifest_for_root(session_id, staging)
        actual_workspace_digest = manifest.get("digest") or ""
        if (
            archive_format == ARCHIVE_FORMAT
            and expected_workspace_digest
            and actual_workspace_digest != expected_workspace_digest
        ):
            raise RuntimeOperationError(
                "workspace_digest_mismatch",
                "restore.verify",
                "Extracted workspace digest does not match archive metadata",
                409,
                {
                    "expectedWorkspaceDigest": expected_workspace_digest,
                    "actualWorkspaceDigest": actual_workspace_digest,
                },
            )

        runtime_chown(staging)
        try:
            if root.exists():
                root.rename(backup)
            staging.rename(root)
        except Exception as error:
            if not root.exists() and backup.exists():
                backup.rename(root)
            raise RuntimeOperationError(
                "workspace_swap_failed",
                "restore.swap",
                f"Failed to activate restored workspace: {error}",
            ) from error

        if backup.exists():
            shutil.rmtree(backup, ignore_errors=True)
        return {
            **manifest,
            "workspace": str(root),
            "archive_format": archive_format,
            "archive_sha256": actual_archive_sha256,
        }
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def serve_file(handler, path: Path):
    content_types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
    }
    if not path.exists() or path.is_dir():
        handler.send_response(404)
        handler.end_headers()
        return
    data = path.read_bytes()
    handler.send_response(200)
    handler.send_header("content-type", content_types.get(path.suffix, "application/octet-stream"))
    handler.send_header("content-length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return

    def do_GET(self):
        parsed = urlparse(self.path)
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        try:
            if parsed.path == "/health":
                claude_bin = ensure_claude_binary()
                try:
                    codex_bin = ensure_codex_binary()
                    codex_version = subprocess.check_output([str(codex_bin), "--version"], text=True).strip()
                    codex_binary = str(codex_bin)
                except Exception as error:
                    codex_version = f"unavailable: {error}"
                    codex_binary = ""
                write_json(self, 200, {
                    "ok": True,
                    "runtime": "integrated-session-mvp",
                    "agent": safe_agent(self.headers.get("x-codeagent-agent")),
                    "model": safe_model(self.headers.get("x-codeagent-model")),
                    "git": subprocess.check_output(["git", "--version"], text=True).strip(),
                    "tmux": subprocess.check_output(["tmux", "-V"], text=True).strip(),
                    "claude": subprocess.check_output([str(claude_bin), "--version"], text=True).strip(),
                    "claudeBinary": str(claude_bin),
                    "claudeChunks": len(list(CLAUDE_CHUNK_DIR.glob("claude.part.*"))),
                    "codex": codex_version,
                    "codexBinary": codex_binary,
                    "codexConfigured": bool(self.headers.get("x-codeagent-openai-api-key")),
                })
                return
            if len(parts) == 2 and parts[0] == "inspect":
                write_json(self, 200, workspace_manifest(parts[1]))
                return
            if len(parts) in {2, 3} and parts[0] == "files":
                query = parse_qs(parsed.query)
                show_hidden = query.get("showHidden", ["false"])[0].lower() == "true"
                if len(parts) == 3 and parts[2] == "status":
                    write_json(
                        self,
                        200,
                        workspace_metadata_status(parts[1], show_hidden),
                    )
                    return
                if len(parts) == 3 and parts[2] == "content":
                    requested_path = query.get("path", [""])[0]
                    if query.get("raw", ["false"])[0].lower() == "true":
                        serve_workspace_file_raw(
                            self, parts[1], requested_path
                        )
                    else:
                        write_json(
                            self,
                            200,
                            workspace_file_preview(parts[1], requested_path),
                        )
                    return
                if len(parts) == 2:
                    write_json(
                        self,
                        200,
                        list_workspace_directory(
                            parts[1], query.get("path", [""])[0], show_hidden
                        ),
                    )
                    return
            if len(parts) == 2 and parts[0] == "tmux":
                query = parse_qs(parsed.query)
                agent = safe_agent(query.get("agent", ["claude"])[0])
                model = safe_model(query.get("model", [""])[0])
                write_json(self, 200, {
                    "ok": True,
                    "session": parts[1],
                    "agent": agent,
                    "model": model,
                    "tmuxSession": session_name(parts[1], agent),
                    "exists": tmux_exists(parts[1], agent),
                })
                return
            if len(parts) == 2 and parts[0] == "archive":
                max_bytes = archive_max_bytes(parsed)
                archive_file, manifest, archive_sha256, archive_size = (
                    make_archive(parts[1], max_bytes)
                )
                try:
                    self.send_response(200)
                    self.send_header("content-type", "application/gzip")
                    self.send_header("content-length", str(archive_size))
                    self.send_header("x-archive-sha256", archive_sha256)
                    self.send_header("x-workspace-digest", manifest["digest"])
                    self.send_header(
                        "x-file-count", str(manifest["file_count"])
                    )
                    self.send_header(
                        "x-workspace-total-bytes",
                        str(manifest["total_bytes"]),
                    )
                    self.send_header(
                        "x-skipped-file-count",
                        str(manifest["skipped_count"]),
                    )
                    self.send_header("x-archive-format", ARCHIVE_FORMAT)
                    self.end_headers()
                    shutil.copyfileobj(
                        archive_file,
                        self.wfile,
                        length=ARCHIVE_IO_CHUNK_BYTES,
                    )
                finally:
                    archive_file.close()
                return
            if len(parts) >= 2 and parts[0] == "preview":
                session_id = parts[1]
                rest = parts[2:]
                if len(rest) == 0:
                    file_path = session_path(session_id) / "dist" / "index.html"
                elif rest == ["api", "session"]:
                    user_id = self.headers.get("x-codeagent-user", "unknown-user")
                    write_json(self, 200, {
                        "ok": True,
                        "userId": user_id,
                        "sessionId": session_id,
                        "runtime": "integrated-session-mvp",
                    })
                    return
                else:
                    file_path = session_path(session_id) / "dist" / Path(*rest)
                serve_file(self, file_path)
                return
            write_json(self, 404, {"ok": False, "error": "not_found", "path": parsed.path})
        except WorkspacePreviewError as error:
            write_json(
                self,
                error.status,
                {"ok": False, "error": error.code},
            )
        except ValueError as error:
            write_json(self, 400, {"ok": False, "error": str(error)})
        except (FileNotFoundError, NotADirectoryError) as error:
            write_json(self, 404, {"ok": False, "error": str(error)})
        except Exception as error:
            write_runtime_error(self, error, "request.get")

    def do_POST(self):
        parsed = urlparse(self.path)
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        try:
            if len(parts) == 2 and parts[0] == "seed":
                write_json(self, 200, seed_workspace(parts[1]))
                return
            if len(parts) == 2 and parts[0] == "clear":
                agent = safe_agent(parse_qs(parsed.query).get("agent", ["claude"])[0])
                kill_tmux(parts[1], agent)
                root = session_path(parts[1])
                if root.exists():
                    shutil.rmtree(root)
                write_json(self, 200, workspace_manifest(parts[1]))
                return
            write_json(self, 404, {"ok": False, "error": "not_found", "path": parsed.path})
        except Exception as error:
            write_runtime_error(self, error, "request.post")

    def do_PUT(self):
        parsed = urlparse(self.path)
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        if len(parts) != 2 or parts[0] != "restore":
            write_json(self, 404, {"ok": False, "error": "not_found", "path": parsed.path})
            return
        length = int(self.headers.get("content-length", "0"))
        try:
            active_agents = sorted(
                agent for agent in AGENTS if tmux_exists(parts[1], agent)
            )
            if active_agents:
                raise RuntimeOperationError(
                    "active_workspace_restore_blocked",
                    "restore.guard",
                    "Restore blocked because the workspace has an active terminal session",
                    409,
                    {"activeAgents": active_agents},
                )
            write_json(
                self,
                200,
                restore_archive(
                    parts[1],
                    self.rfile.read(length),
                    self.headers.get("x-expected-workspace-digest", ""),
                    self.headers.get("x-expected-archive-sha256", ""),
                    self.headers.get("x-archive-format", "1"),
                ),
            )
        except Exception as error:
            write_runtime_error(self, error, "restore.request")

    def setup(self):
        super().setup()
        self.request.settimeout(None)

    def handle(self):
        data = self.request.recv(65536, socket.MSG_PEEK)
        if b"Upgrade: websocket" not in data and b"upgrade: websocket" not in data:
            return super().handle()
        request = self.request.recv(65536).decode("utf-8", errors="ignore")
        lines = request.split("\r\n")
        path = lines[0].split(" ")[1]
        parsed = urlparse(path)
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.lower()] = value.strip()
        if not parsed.path.startswith("/terminal/"):
            self.request.close()
            return
        key = headers.get("sec-websocket-key", "")
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        self.request.sendall((
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        ).encode())
        query = parse_qs(parsed.query)
        agent = safe_agent(query.get("agent", [headers.get("x-codeagent-agent", "claude")])[0])
        model = safe_model(query.get("model", [headers.get("x-codeagent-model", "")])[0])
        self.serve_terminal(
            unquote(parsed.path.removeprefix("/terminal/")),
            query.get("base_url", [""])[0],
            agent,
            model,
            headers.get("x-codeagent-openai-api-key", ""),
        )

    def serve_terminal(
        self,
        session_id: str,
        base_url: str,
        agent: str,
        model: str,
        model_gateway_token: str,
    ):
        if not base_url:
            self.request.sendall(encode_frame(b"Missing base_url\r\n"))
            self.request.close()
            return
        agent = safe_agent(agent)
        tmux_name, _ = ensure_agent_tmux(
            session_id,
            base_url,
            agent,
            model_gateway_token,
            model,
        )
        reset_tmux_interaction_state(tmux_name)
        master_fd, slave_fd = pty.openpty()
        rows, cols = terminal_size(DEFAULT_TERMINAL_ROWS, DEFAULT_TERMINAL_COLS)
        set_winsize(master_fd, rows, cols)
        resize_tmux_window(session_id, rows, cols, agent)
        client = subprocess.Popen(
            ["tmux", "attach-session", "-t", tmux_name],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env={**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"},
            start_new_session=True,
            **runtime_subprocess_kwargs(),
        )
        os.close(slave_fd)
        self.request.sendall(encode_frame(f"Connected to integrated tmux session ({agent}): {tmux_name}\r\n".encode()))
        stop = threading.Event()

        def pump_pty():
            while not stop.is_set():
                readable, _, _ = select.select([master_fd], [], [], 0.1)
                if master_fd in readable:
                    try:
                        chunk = os.read(master_fd, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    self.request.sendall(encode_frame(chunk))

        threading.Thread(target=pump_pty, daemon=True).start()
        try:
            while True:
                message = decode_frame(self.request)
                if message is None:
                    break
                try:
                    payload = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if payload.get("type") == "input":
                    os.write(master_fd, payload.get("data", "").encode())
                elif payload.get("type") == "resize":
                    rows, cols = terminal_size(payload.get("rows"), payload.get("cols"))
                    set_winsize(master_fd, rows, cols)
                    resize_tmux_window(session_id, rows, cols, agent)
        finally:
            stop.set()
            try:
                os.killpg(os.getpgid(client.pid), signal.SIGTERM)
            except Exception:
                pass
            try:
                os.close(master_fd)
            except Exception:
                pass


class ThreadingServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get("PORT", "8080"))
    with ThreadingServer(("0.0.0.0", port), Handler) as server:
        print(f"integrated session container listening on {port}", flush=True)
        server.serve_forever()
