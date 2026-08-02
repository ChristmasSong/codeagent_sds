import hashlib
import importlib.util
import io
import json
import os
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock
from urllib.parse import urlparse


SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("hicode_runtime_server", SERVER_PATH)
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class RecordingHandler:
    def __init__(self):
        self.status = None
        self.headers = {}
        self.wfile = io.BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.headers[name.lower()] = value

    def end_headers(self):
        pass


class BoundedReadStream(io.BytesIO):
    def __init__(self, data: bytes, max_read_size: int, per_read_limit=None):
        super().__init__(data)
        self.max_read_size = max_read_size
        self.per_read_limit = per_read_limit or max_read_size
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        if size < 0 or size > self.max_read_size:
            raise AssertionError(f"unbounded archive read requested: {size}")
        return super().read(min(size, self.per_read_limit))


class AgentCredentialTests(unittest.TestCase):
    def test_session_gateway_token_reaches_both_agent_environments(self):
        fixture_credential = "test-only-session-gateway-credential"
        claude = server.claude_process_env(
            Path("/tmp/claude-home"),
            Path("/tmp/claude-config"),
            "https://runtime.example/api/model/session/s-1",
            fixture_credential,
        )
        codex = server.codex_process_env(
            Path("/tmp/codex-home"), fixture_credential
        )

        self.assertEqual(
            claude["CODEAGENT_ANTHROPIC_API_KEY"], fixture_credential
        )
        self.assertEqual(codex["OPENAI_API_KEY"], fixture_credential)
        self.assertNotIn("ANTHROPIC_API_KEY", claude)
        self.assertNotIn("ANTHROPIC_API_KEY", codex)

    def test_agent_router_passes_gateway_token_to_claude(self):
        with mock.patch.object(
            server,
            "ensure_claude_tmux",
            return_value=("claude-s-1", Path("/tmp/workspace")),
        ) as ensure_claude:
            server.ensure_agent_tmux(
                "s-1",
                "https://runtime.example/api/model/session/s-1",
                "claude",
                "cgw1_session-token",
                "claude-sonnet",
            )

        ensure_claude.assert_called_once_with(
            "s-1",
            "https://runtime.example/api/model/session/s-1",
            "claude-sonnet",
            "cgw1_session-token",
        )


class WorkspaceArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_root = server.ROOT
        server.ROOT = Path(self.temp_dir.name) / "sessions"
        server.ROOT.mkdir(parents=True)
        self.session_id = "session-test"
        self.root = server.session_path(self.session_id)
        self.root.mkdir(parents=True)

    def tearDown(self):
        server.ROOT = self.original_root
        self.temp_dir.cleanup()

    def write(self, relative: str, content: bytes):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def archive_entries(self, data: bytes):
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            return {
                member.name: archive.extractfile(member).read()
                for member in archive.getmembers()
                if member.isfile()
            }

    def build_archive(self, max_bytes=None):
        archive_file, manifest, archive_sha256, archive_size = (
            server.make_archive(self.session_id, max_bytes)
        )
        try:
            data = archive_file.read()
        finally:
            archive_file.close()
        self.assertEqual(len(data), archive_size)
        self.assertEqual(server.sha256_bytes(data), archive_sha256)
        return data, manifest

    def test_archive_excludes_regenerable_dependencies(self):
        self.write("src/index.ts", b"export const value = 1;\n")
        self.write("node_modules/pkg/index.js", b"ignored\n")
        self.write(".next/cache/data.bin", b"ignored\n")

        data, manifest = self.build_archive()
        entries = self.archive_entries(data)

        self.assertEqual(set(entries), {"src/index.ts"})
        self.assertEqual(manifest["file_count"], 1)
        self.assertEqual(
            manifest["total_bytes"], len(b"export const value = 1;\n")
        )
        self.assertEqual(manifest["skipped_count"], 2)

    def test_manifest_digest_is_computed_from_archived_bytes(self):
        self.write("README.md", b"snapshot\n")
        self.write("src/main.js", b"console.log('snapshot');\n")

        data, manifest = self.build_archive()
        entries = self.archive_entries(data)
        digest = hashlib.sha256()
        for path, content in sorted(entries.items()):
            digest.update(path.encode())
            digest.update(b"\0")
            digest.update(hashlib.sha256(content).hexdigest().encode())
            digest.update(b"\0")

        self.assertEqual(manifest["digest"], digest.hexdigest())

    def test_snapshot_and_manifest_do_not_buffer_whole_files(self):
        self.write("large.bin", b"x" * (server.ARCHIVE_IO_CHUNK_BYTES + 7))

        entries, skipped = server.snapshot_workspace(self.root)

        self.assertEqual(skipped, [])
        self.assertNotIn("data", entries[0])
        self.assertEqual(entries[0]["size"], server.ARCHIVE_IO_CHUNK_BYTES + 7)
        with mock.patch.object(
            Path,
            "read_bytes",
            side_effect=AssertionError("whole-file read is not allowed"),
        ):
            manifest = server.manifest_from_entries(
                self.session_id,
                entries,
                skipped,
            )

        self.assertEqual(
            manifest["files"][0]["sha256"],
            hashlib.sha256(b"x" * (server.ARCHIVE_IO_CHUNK_BYTES + 7)).hexdigest(),
        )

    def test_archive_uses_temp_file_without_whole_file_reads(self):
        self.write("src/main.js", b"console.log('streamed');\n")

        with mock.patch.object(
            Path,
            "read_bytes",
            side_effect=AssertionError("whole-file read is not allowed"),
        ):
            data, manifest = self.build_archive()

        self.assertEqual(
            self.archive_entries(data)["src/main.js"],
            b"console.log('streamed');\n",
        )
        self.assertEqual(manifest["file_count"], 1)

    def test_archive_quota_rejects_from_stat_before_reading_contents(self):
        oversized = self.root / "oversized.bin"
        with oversized.open("wb") as file:
            file.truncate(1025)

        with mock.patch.object(
            Path,
            "open",
            side_effect=AssertionError("content should not be opened"),
        ):
            with self.assertRaises(server.RuntimeOperationError) as raised:
                server.make_archive(self.session_id, max_bytes=1024)

        self.assertEqual(raised.exception.status, 413)
        self.assertEqual(raised.exception.code, "archive_size_exceeded")
        self.assertEqual(raised.exception.stage, "archive.quota")
        self.assertEqual(raised.exception.details["maxBytes"], 1024)
        self.assertEqual(raised.exception.details["actualBytes"], 1025)

    def test_archive_query_max_bytes_validation(self):
        self.assertEqual(
            server.archive_max_bytes(
                urlparse("/archive/session-test?maxBytes=123")
            ),
            123,
        )
        self.assertIsNone(
            server.archive_max_bytes(urlparse("/archive/session-test"))
        )
        for value in ["", "-1", "1.5", "9007199254740992"]:
            with self.subTest(value=value):
                with self.assertRaises(
                    server.RuntimeOperationError
                ) as raised:
                    server.archive_max_bytes(
                        urlparse(
                            f"/archive/session-test?maxBytes={value}"
                        )
                    )
                self.assertEqual(raised.exception.status, 400)
                self.assertEqual(
                    raised.exception.code,
                    "invalid_archive_max_bytes",
                )

    def test_archive_route_enforces_query_quota_before_file_reads(self):
        oversized = self.root / "oversized.bin"
        with oversized.open("wb") as file:
            file.truncate(1025)
        handler = RecordingHandler()
        handler.path = f"/archive/{self.session_id}?maxBytes=1024"
        handler.headers = {}

        with mock.patch.object(
            Path,
            "open",
            side_effect=AssertionError("content should not be opened"),
        ):
            server.Handler.do_GET(handler)

        payload = json.loads(handler.wfile.getvalue())
        self.assertEqual(handler.status, 413)
        self.assertEqual(payload["code"], "archive_size_exceeded")
        self.assertEqual(payload["stage"], "archive.quota")

    def test_archive_route_streams_compatible_gzip_response(self):
        self.write("README.md", b"stream me\n")
        handler = RecordingHandler()
        handler.path = f"/archive/{self.session_id}?maxBytes=4096"
        handler.headers = {}

        server.Handler.do_GET(handler)

        data = handler.wfile.getvalue()
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.headers["content-type"], "application/gzip")
        self.assertEqual(int(handler.headers["content-length"]), len(data))
        self.assertEqual(
            handler.headers["x-archive-sha256"],
            server.sha256_bytes(data),
        )
        self.assertEqual(
            self.archive_entries(data),
            {"README.md": b"stream me\n"},
        )

    def test_successful_restore_replaces_workspace_after_validation(self):
        self.write("old.txt", b"old\n")
        replacement_root = Path(self.temp_dir.name) / "replacement"
        replacement_root.mkdir()
        (replacement_root / "new.txt").write_bytes(b"new\n")
        entries, skipped = server.snapshot_workspace(replacement_root)
        expected = server.manifest_from_entries(self.session_id, entries, skipped)
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:gz") as tar:
            info = tarfile.TarInfo("new.txt")
            info.size = 4
            tar.addfile(info, io.BytesIO(b"new\n"))
        data = archive.getvalue()

        restored = server.restore_archive(
            self.session_id,
            data,
            expected["digest"],
            server.sha256_bytes(data),
            server.ARCHIVE_FORMAT,
        )

        self.assertFalse((self.root / "old.txt").exists())
        self.assertEqual((self.root / "new.txt").read_bytes(), b"new\n")
        self.assertEqual(restored["digest"], expected["digest"])

    def test_restore_accepts_seekable_file_without_unbounded_reads(self):
        self.write("old.txt", b"old\n")
        chunk_bytes = 16 * 1024
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:gz") as tar:
            content = os.urandom(chunk_bytes + 7)
            info = tarfile.TarInfo("streamed.txt")
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
        data = archive.getvalue()
        source = BoundedReadStream(data, chunk_bytes)

        with mock.patch.object(server, "ARCHIVE_IO_CHUNK_BYTES", chunk_bytes):
            restored = server.restore_archive(
                self.session_id,
                source,
                expected_archive_sha256=server.sha256_bytes(data),
                archive_format=server.ARCHIVE_FORMAT,
            )

        self.assertEqual((self.root / "streamed.txt").read_bytes(), content)
        self.assertEqual(restored["archive_sha256"], server.sha256_bytes(data))
        self.assertGreater(len(source.read_sizes), 1)
        self.assertTrue(
            all(0 <= size <= chunk_bytes for size in source.read_sizes)
        )

    def test_restore_accepts_archive_path(self):
        self.write("old.txt", b"old\n")
        archive_path = Path(self.temp_dir.name) / "restore.tar.gz"
        with tarfile.open(archive_path, mode="w:gz") as tar:
            content = b"restored from path\n"
            info = tarfile.TarInfo("path.txt")
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
        with archive_path.open("rb") as archive_file:
            expected_archive_sha256 = server.archive_file_sha256(archive_file)

        restored = server.restore_archive(
            self.session_id,
            archive_path,
            expected_archive_sha256=expected_archive_sha256,
            archive_format=server.ARCHIVE_FORMAT,
        )

        self.assertEqual((self.root / "path.txt").read_bytes(), content)
        self.assertEqual(restored["file_count"], 1)

    def test_restore_route_spools_request_body_in_bounded_chunks(self):
        self.write("old.txt", b"old\n")
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:gz") as tar:
            content = b"request body restore\n" * 1024
            info = tarfile.TarInfo("request.txt")
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
        data = archive.getvalue()
        source = BoundedReadStream(data, 31, per_read_limit=7)
        handler = RecordingHandler()
        handler.path = f"/restore/{self.session_id}"
        handler.headers = {
            "content-length": str(len(data)),
            "x-expected-archive-sha256": server.sha256_bytes(data),
            "x-archive-format": server.ARCHIVE_FORMAT,
        }
        handler.rfile = source

        with mock.patch.object(server, "ARCHIVE_IO_CHUNK_BYTES", 31), mock.patch.object(
            server, "tmux_exists", return_value=False
        ):
            server.Handler.do_PUT(handler)

        self.assertEqual(handler.status, 200)
        self.assertEqual((self.root / "request.txt").read_bytes(), content)
        self.assertGreater(len(source.read_sizes), 1)
        self.assertTrue(all(0 <= size <= 31 for size in source.read_sizes))

    def test_restore_route_rejects_incomplete_request_without_replacing_workspace(
        self,
    ):
        self.write("old.txt", b"keep me\n")
        handler = RecordingHandler()
        handler.path = f"/restore/{self.session_id}"
        handler.headers = {"content-length": "10"}
        handler.rfile = io.BytesIO(b"short")

        with mock.patch.object(server, "tmux_exists", return_value=False):
            server.Handler.do_PUT(handler)

        payload = json.loads(handler.wfile.getvalue())
        self.assertEqual(handler.status, 400)
        self.assertEqual(payload["code"], "restore_incomplete")
        self.assertEqual((self.root / "old.txt").read_bytes(), b"keep me\n")

    def test_archive_restore_and_clear_share_workspace_operation_lock(self):
        self.write("old.txt", b"keep me\n")
        archive_handler = RecordingHandler()
        archive_handler.path = f"/archive/{self.session_id}"
        archive_handler.headers = {}
        restore_body = mock.Mock()
        restore_handler = RecordingHandler()
        restore_handler.path = f"/restore/{self.session_id}"
        restore_handler.headers = {"content-length": "1"}
        restore_handler.rfile = restore_body
        clear_handler = RecordingHandler()
        clear_handler.path = f"/clear/{self.session_id}"
        clear_handler.headers = {}

        with server.workspace_file_transfer(self.session_id, "upload.lock"):
            server.Handler.do_GET(archive_handler)
            server.Handler.do_PUT(restore_handler)
            with mock.patch.object(server, "kill_tmux") as kill_tmux:
                server.Handler.do_POST(clear_handler)

        for handler in [archive_handler, restore_handler, clear_handler]:
            payload = json.loads(handler.wfile.getvalue())
            self.assertEqual(handler.status, 429)
            self.assertEqual(payload["code"], "workspace_transfer_busy")
        restore_body.read.assert_not_called()
        kill_tmux.assert_not_called()
        self.assertEqual((self.root / "old.txt").read_bytes(), b"keep me\n")

    def test_digest_failure_preserves_existing_workspace(self):
        self.write("old.txt", b"keep me\n")
        data, _manifest = self.build_archive()

        with self.assertRaises(server.RuntimeOperationError) as raised:
            server.restore_archive(
                self.session_id,
                data,
                "not-the-real-digest",
                server.sha256_bytes(data),
                server.ARCHIVE_FORMAT,
            )

        self.assertEqual(raised.exception.code, "workspace_digest_mismatch")
        self.assertEqual(raised.exception.stage, "restore.verify")
        self.assertEqual((self.root / "old.txt").read_bytes(), b"keep me\n")

    def test_checksum_failure_preserves_existing_workspace(self):
        self.write("old.txt", b"keep me\n")
        data, _manifest = self.build_archive()

        with self.assertRaises(server.RuntimeOperationError) as raised:
            server.restore_archive(
                self.session_id,
                io.BytesIO(data),
                expected_archive_sha256="0" * 64,
                archive_format=server.ARCHIVE_FORMAT,
            )

        self.assertEqual(raised.exception.code, "archive_checksum_mismatch")
        self.assertEqual(raised.exception.stage, "restore.validate")
        self.assertEqual((self.root / "old.txt").read_bytes(), b"keep me\n")

    def test_corrupt_archive_preserves_existing_workspace(self):
        self.write("old.txt", b"keep me\n")
        data = b"not a gzip archive"

        with self.assertRaises(server.RuntimeOperationError) as raised:
            server.restore_archive(
                self.session_id,
                io.BytesIO(data),
                expected_archive_sha256=server.sha256_bytes(data),
                archive_format=server.ARCHIVE_FORMAT,
            )

        self.assertEqual(raised.exception.code, "archive_extract_failed")
        self.assertEqual(raised.exception.stage, "restore.extract")
        self.assertEqual((self.root / "old.txt").read_bytes(), b"keep me\n")

    def test_unsafe_archive_preserves_existing_workspace(self):
        self.write("old.txt", b"keep me\n")
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:gz") as tar:
            info = tarfile.TarInfo("../escape.txt")
            info.size = 7
            tar.addfile(info, io.BytesIO(b"escape\n"))
        data = archive.getvalue()

        with self.assertRaises(server.RuntimeOperationError) as raised:
            server.restore_archive(
                self.session_id,
                data,
                expected_archive_sha256=server.sha256_bytes(data),
                archive_format=server.ARCHIVE_FORMAT,
            )

        self.assertEqual(raised.exception.code, "unsafe_archive_path")
        self.assertEqual((self.root / "old.txt").read_bytes(), b"keep me\n")
        self.assertFalse((server.ROOT.parent / "escape.txt").exists())

    def test_unsupported_archive_entry_preserves_existing_workspace(self):
        self.write("old.txt", b"keep me\n")
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:gz") as tar:
            link = tarfile.TarInfo("workspace-link")
            link.type = tarfile.SYMTYPE
            link.linkname = "old.txt"
            tar.addfile(link)
        data = archive.getvalue()

        with self.assertRaises(server.RuntimeOperationError) as raised:
            server.restore_archive(
                self.session_id,
                io.BytesIO(data),
                expected_archive_sha256=server.sha256_bytes(data),
                archive_format=server.ARCHIVE_FORMAT,
            )

        self.assertEqual(raised.exception.code, "unsupported_archive_entry")
        self.assertEqual(raised.exception.stage, "restore.validate")
        self.assertEqual((self.root / "old.txt").read_bytes(), b"keep me\n")
        self.assertFalse((self.root / "workspace-link").exists())


class WorkspaceFilesTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_root = server.ROOT
        server.ROOT = Path(self.temp_dir.name) / "sessions"
        self.workspace = server.session_path("session-1")
        (self.workspace / "src").mkdir(parents=True)
        (self.workspace / "src" / "app.ts").write_text(
            "export const app = true;\n", encoding="utf-8"
        )
        (self.workspace / "README.md").write_text("# Demo\n", encoding="utf-8")
        (self.workspace / ".git").mkdir()
        (self.workspace / ".git" / "config").write_text(
            "hidden", encoding="utf-8"
        )
        (self.workspace / "node_modules").mkdir()
        (self.workspace / "node_modules" / "pkg.js").write_text(
            "ignored", encoding="utf-8"
        )

    def tearDown(self):
        server.ROOT = self.original_root
        self.temp_dir.cleanup()

    def test_lists_one_directory_level_and_hides_ignored_entries(self):
        result = server.list_workspace_directory("session-1")

        self.assertTrue(result["exists"])
        self.assertEqual(
            [entry["name"] for entry in result["entries"]],
            ["src", "README.md"],
        )
        self.assertEqual(result["entries"][0]["type"], "directory")
        self.assertTrue(result["entries"][0]["hasChildren"])

        nested = server.list_workspace_directory("session-1", "src")
        self.assertEqual(
            [entry["path"] for entry in nested["entries"]],
            ["src/app.ts"],
        )

    def test_rejects_paths_outside_the_session_root(self):
        with self.assertRaises(ValueError):
            server.list_workspace_directory("session-1", "../../outside")

        with self.assertRaises(ValueError):
            server.list_workspace_directory("session-1", "/etc")

    def test_metadata_digest_changes_without_reading_file_contents(self):
        before = server.workspace_metadata_status("session-1")
        (self.workspace / "created.txt").write_text("new", encoding="utf-8")
        after = server.workspace_metadata_status("session-1")

        self.assertNotEqual(before["digest"], after["digest"])
        self.assertEqual(after["entryCount"], before["entryCount"] + 1)

    def test_metadata_scan_stops_at_the_configured_limit(self):
        original_limit = server.MAX_STATUS_ENTRIES
        server.MAX_STATUS_ENTRIES = 10
        try:
            for index in range(20):
                (self.workspace / f"status-{index:02}.txt").touch()

            result = server.workspace_metadata_status("session-1")

            self.assertTrue(result["truncated"])
            self.assertEqual(result["entryCount"], 10)
        finally:
            server.MAX_STATUS_ENTRIES = original_limit

    def test_directory_listing_is_sorted_and_bounded(self):
        for index in range(server.MAX_DIRECTORY_ENTRIES + 5):
            (self.workspace / f"generated-{index:04}.txt").touch()

        result = server.list_workspace_directory("session-1")

        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["entries"]), server.MAX_DIRECTORY_ENTRIES)
        names = [entry["name"] for entry in result["entries"]]
        self.assertEqual(names[0], "src")
        self.assertEqual(names[1:], sorted(names[1:], key=str.lower))

    def test_previews_utf8_markdown_and_reports_metadata(self):
        markdown = self.workspace / "README.md"
        markdown.write_text("# 你好 👋\n", encoding="utf-8")

        result = server.workspace_file_preview("session-1", "README.md")

        self.assertEqual(result["kind"], "markdown")
        self.assertEqual(result["content"], "# 你好 👋\n")
        self.assertEqual(result["encoding"], "utf-8")
        self.assertEqual(
            result["mimeType"], "text/markdown; charset=utf-8"
        )
        self.assertTrue(result["previewable"])
        self.assertFalse(result["truncated"])
        self.assertEqual(len(result["etag"]), 64)
        self.assertNotIn(str(self.workspace), str(result))

    def test_truncates_text_without_splitting_utf8(self):
        value = ("a" * (server.MAX_TEXT_PREVIEW_BYTES - 1)) + "😀"
        (self.workspace / "large.txt").write_text(value, encoding="utf-8")

        result = server.workspace_file_preview("session-1", "large.txt")

        self.assertEqual(result["kind"], "text")
        self.assertTrue(result["tooLarge"])
        self.assertTrue(result["truncated"])
        self.assertNotIn("\ufffd", result["content"])
        result["content"].encode("utf-8")

    def test_rejects_hidden_sensitive_and_symlink_paths(self):
        outside = Path(self.temp_dir.name) / "outside.txt"
        outside.write_text("secret", encoding="utf-8")
        outside_directory = Path(self.temp_dir.name) / "outside"
        outside_directory.mkdir()
        (outside_directory / "nested.txt").write_text(
            "secret", encoding="utf-8"
        )
        (self.workspace / "outside-link.txt").symlink_to(outside)
        (self.workspace / "outside-directory").symlink_to(
            outside_directory, target_is_directory=True
        )
        (self.workspace / "inside-link.txt").symlink_to(
            self.workspace / "README.md"
        )
        (self.workspace / "secret.pem").write_text("key", encoding="utf-8")
        (self.workspace / ".env").write_text(
            "SECRET=value", encoding="utf-8"
        )
        os.mkfifo(self.workspace / "named-pipe")

        for requested_path in [
            ".git/config",
            ".env",
            "node_modules/pkg.js",
            "secret.pem",
            "outside-link.txt",
            "outside-directory/nested.txt",
            "inside-link.txt",
            "named-pipe",
            "../outside.txt",
            "/etc/passwd",
        ]:
            with self.subTest(path=requested_path):
                with self.assertRaises(server.WorkspacePreviewError):
                    server.workspace_file_preview("session-1", requested_path)

        listed_names = {
            entry["name"]
            for entry in server.list_workspace_directory("session-1")["entries"]
        }
        self.assertNotIn("inside-link.txt", listed_names)
        self.assertNotIn("named-pipe", listed_names)

    def test_validates_media_signatures_and_size_limits(self):
        (self.workspace / "image.png").write_bytes(
            b"\x89PNG\r\n\x1a\n" + b"preview"
        )
        (self.workspace / "fake.png").write_text(
            "not an image", encoding="utf-8"
        )
        result = server.workspace_file_preview("session-1", "image.png")
        fake = server.workspace_file_preview("session-1", "fake.png")

        self.assertEqual(result["kind"], "image")
        self.assertEqual(result["mimeType"], "image/png")
        self.assertTrue(result["rawAvailable"])
        self.assertEqual(fake["kind"], "binary")
        self.assertFalse(fake["previewable"])

        oversized = self.workspace / "oversized.png"
        with oversized.open("wb") as file:
            file.write(b"\x89PNG\r\n\x1a\n")
            file.truncate(server.MAX_IMAGE_PREVIEW_BYTES + 1)
        metadata = server.workspace_file_preview("session-1", "oversized.png")
        self.assertTrue(metadata["tooLarge"])
        self.assertFalse(metadata["rawAvailable"])
        with self.assertRaises(server.WorkspacePreviewError) as raised:
            server.serve_workspace_file_raw(
                None, "session-1", "oversized.png"
            )
        self.assertEqual(raised.exception.code, "file_too_large")

    def test_raw_html_response_is_sandboxed_and_does_not_leak_paths(self):
        (self.workspace / "preview.html").write_text(
            "<script>globalThis.pwned = true</script><h1>Hello</h1>",
            encoding="utf-8",
        )
        metadata = server.workspace_file_preview(
            "session-1", "preview.html"
        )
        self.assertEqual(metadata["kind"], "html")
        self.assertIn("<script>", metadata["content"])
        self.assertTrue(metadata["rawAvailable"])

        handler = RecordingHandler()
        server.serve_workspace_file_raw(
            handler, "session-1", "preview.html"
        )
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.headers["x-file-preview-kind"], "html")
        self.assertIn("sandbox", handler.headers["content-security-policy"])
        self.assertEqual(
            handler.headers["x-content-type-options"], "nosniff"
        )
        self.assertIn(b"<script>", handler.wfile.getvalue())
        self.assertNotIn(
            str(self.workspace), "\n".join(handler.headers.values())
        )

    def office_document(self, required_entry: str, include_macro=False):
        output = io.BytesIO()
        with zipfile.ZipFile(output, mode="w") as document:
            document.writestr(
                "[Content_Types].xml",
                b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
            )
            document.writestr(required_entry, b"<document />")
            if include_macro:
                document.writestr("word/vbaProject.bin", b"macro")
        return output.getvalue()

    def upload(self, path: str, data: bytes, **kwargs):
        return server.upload_workspace_file(
            "session-1",
            path,
            io.BytesIO(data),
            len(data),
            **kwargs,
        )

    def test_uploads_supported_images_documents_and_utf8_text(self):
        fixtures = {
            "src/image.png": b"\x89PNG\r\n\x1a\nimage",
            "src/image.jpg": b"\xff\xd8\xffimage",
            "src/image.webp": b"RIFF\x04\x00\x00\x00WEBPdata",
            "src/image.gif": b"GIF89aimage",
            "src/report.pdf": b"%PDF-1.7\nbody",
            "src/report.docx": self.office_document("word/document.xml"),
            "src/report.xlsx": self.office_document("xl/workbook.xml"),
            "src/report.pptx": self.office_document("ppt/presentation.xml"),
            "src/notes.txt": "你好，sandbox\n".encode(),
            "src/config.unknown": b"plain UTF-8 text\n",
        }

        for path, data in fixtures.items():
            with self.subTest(path=path):
                result = self.upload(path, data, if_none_match="*")
                self.assertEqual((self.workspace / path).read_bytes(), data)
                self.assertEqual(result["path"], path)
                self.assertEqual(result["size"], len(data))
                self.assertEqual(len(result["etag"]), 64)
                self.assertFalse(result["overwritten"])

        self.assertEqual(
            server.workspace_file_preview("session-1", "src/notes.txt")["content"],
            "你好，sandbox\n",
        )

    def test_upload_rejects_disguised_binary_macro_and_invalid_text(self):
        fixtures = {
            "src/fake.png": b"not actually an image",
            "src/binary.bin": b"\xff\xfe\x00binary",
            "src/nul.txt": b"text\x00with nul",
            "src/archive.gz": b"plain text with an archive suffix",
            "src/archive.zip": self.office_document("word/document.xml"),
            "src/macro.docx": self.office_document(
                "word/document.xml", include_macro=True
            ),
        }

        for path, data in fixtures.items():
            with self.subTest(path=path):
                with self.assertRaises(server.RuntimeOperationError) as raised:
                    self.upload(path, data)
                self.assertEqual(raised.exception.code, "unsupported_file_type")
                self.assertEqual(raised.exception.status, 415)
                self.assertFalse((self.workspace / path).exists())

        self.assertEqual(
            list(self.workspace.rglob(f"{server.UPLOAD_TEMP_PREFIX}*")), []
        )

    def test_office_upload_rejects_entry_bomb_before_zip_parsing(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, mode="w") as document:
            for index in range(server.MAX_OFFICE_ZIP_ENTRIES + 1):
                document.writestr(f"entry-{index}", b"")
        payload = bytearray(output.getvalue())
        eocd_index = payload.rfind(b"PK\x05\x06")
        self.assertGreaterEqual(eocd_index, 0)
        # Lie about both EOCD entry counts. The preflight must count actual
        # central-directory records instead of trusting these fields.
        server.struct.pack_into("<HH", payload, eocd_index + 8, 1, 1)

        with tempfile.TemporaryFile(mode="w+b") as source:
            source.write(payload)
            source.flush()
            with mock.patch.object(server.zipfile, "ZipFile") as zip_reader:
                with self.assertRaises(server.RuntimeOperationError) as raised:
                    server.validate_office_upload(
                        source.fileno(), "word/document.xml"
                    )

        zip_reader.assert_not_called()
        self.assertEqual(raised.exception.code, "unsupported_file_type")
        self.assertEqual(raised.exception.status, 415)

    def test_upload_uses_conditional_atomic_overwrite(self):
        original = self.workspace / "README.md"
        original_bytes = original.read_bytes()

        with self.assertRaises(server.RuntimeOperationError) as conflict:
            self.upload("README.md", b"replacement")
        self.assertEqual(conflict.exception.code, "file_already_exists")
        self.assertEqual(original.read_bytes(), original_bytes)

        etag = server.workspace_file_etag(os.stat(original, follow_symlinks=False))
        with self.assertRaises(server.RuntimeOperationError) as mismatch:
            self.upload("README.md", b"replacement", if_match="0" * 64)
        self.assertEqual(mismatch.exception.code, "etag_mismatch")
        self.assertEqual(original.read_bytes(), original_bytes)

        result = self.upload(
            "README.md", b"replacement", if_match=f'"{etag}"'
        )
        self.assertTrue(result["overwritten"])
        self.assertEqual(original.read_bytes(), b"replacement")
        self.assertNotEqual(result["etag"], etag)

    def test_upload_enforces_actual_length_size_and_workspace_quota(self):
        with self.assertRaises(server.RuntimeOperationError) as incomplete:
            server.upload_workspace_file(
                "session-1",
                "src/incomplete.txt",
                io.BytesIO(b"short"),
                10,
            )
        self.assertEqual(incomplete.exception.code, "upload_incomplete")
        self.assertFalse((self.workspace / "src" / "incomplete.txt").exists())

        with mock.patch.object(server, "MAX_UPLOAD_FILE_BYTES", 4):
            with self.assertRaises(server.RuntimeOperationError) as oversized:
                self.upload("src/oversized.txt", b"12345")
        self.assertEqual(oversized.exception.code, "file_too_large")

        workspace_bytes = server.workspace_regular_file_bytes(self.workspace)
        with self.assertRaises(server.RuntimeOperationError) as quota:
            self.upload(
                "src/quota.txt",
                b"123",
                workspace_max_bytes=workspace_bytes + 2,
            )
        self.assertEqual(quota.exception.code, "workspace_size_exceeded")
        self.assertFalse((self.workspace / "src" / "quota.txt").exists())
        self.assertEqual(
            list(self.workspace.rglob(f"{server.UPLOAD_TEMP_PREFIX}*")), []
        )

    def test_upload_quota_counts_only_persistable_workspace_files(self):
        expected = (self.workspace / "README.md").stat().st_size
        expected += (self.workspace / "src" / "app.ts").stat().st_size
        # The pre-existing archive contract persists .git; upload quota uses
        # that same contract while excluding regenerable dependencies/caches.
        expected += (self.workspace / ".git" / "config").stat().st_size
        self.assertEqual(
            server.workspace_regular_file_bytes(self.workspace), expected
        )

        (self.workspace / ".next" / "cache").mkdir(parents=True)
        (self.workspace / ".next" / "cache" / "large.bin").write_bytes(
            b"x" * 10_000
        )
        (self.workspace / f"{server.UPLOAD_TEMP_PREFIX}partial.tmp").write_bytes(
            b"x" * 10_000
        )
        outside = Path(self.temp_dir.name) / "outside-quota.bin"
        outside.write_bytes(b"x" * 10_000)
        (self.workspace / "quota-link").symlink_to(outside)

        self.assertEqual(
            server.workspace_regular_file_bytes(self.workspace), expected
        )
        self.assertTrue(
            server.archive_path_is_excluded(
                server.PurePosixPath(f"{server.UPLOAD_TEMP_PREFIX}partial.tmp")
            )
        )

    def test_upload_rejects_unsafe_parent_and_target_paths(self):
        outside = Path(self.temp_dir.name) / "outside"
        outside.mkdir()
        (self.workspace / "linked").symlink_to(outside, target_is_directory=True)
        for path in [
            "../escape.txt",
            "/absolute.txt",
            "C:/escape.txt",
            "C:escape.txt",
            ".env",
            "node_modules/new.txt",
            "src\\escape.txt",
            "linked/escape.txt",
        ]:
            with self.subTest(path=path):
                with self.assertRaises(server.RuntimeOperationError):
                    self.upload(path, b"safe text")
        self.assertFalse((outside / "escape.txt").exists())

    def test_download_all_builds_safe_zip_and_excludes_platform_files(self):
        (self.workspace / ".env").write_text("USER_SETTING=yes\n")
        (self.workspace / "dist").mkdir()
        (self.workspace / "dist" / "artifact.bin").write_bytes(b"\x00\xff")
        (self.workspace / "empty").mkdir()
        (self.workspace / ".next" / "cache").mkdir(parents=True)
        (self.workspace / ".next" / "cache" / "cached.bin").write_bytes(b"x")
        (self.workspace / ".output" / "cache").mkdir(parents=True)
        (self.workspace / ".output" / "cache" / "cached.bin").write_bytes(b"x")
        (self.workspace / f"{server.UPLOAD_TEMP_PREFIX}orphan.tmp").write_bytes(
            b"partial"
        )
        outside = Path(self.temp_dir.name) / "outside.txt"
        outside.write_text("outside")
        (self.workspace / "outside-link").symlink_to(outside)
        os.mkfifo(self.workspace / "pipe")
        (self.workspace / "..\\escape.txt").write_text("unsafe name")
        (self.workspace / "C:").mkdir()
        (self.workspace / "C:" / "drive.txt").write_text("unsafe drive")
        (self.workspace / "safe.txt:stream").write_text("unsafe stream")

        archive_file, metadata = server.make_workspace_zip("session-1")
        try:
            with zipfile.ZipFile(archive_file) as archive:
                names = set(archive.namelist())
                self.assertIn("README.md", names)
                self.assertIn("src/app.ts", names)
                self.assertIn("dist/artifact.bin", names)
                self.assertIn(".env", names)
                self.assertIn("empty/", names)
                self.assertEqual(archive.read("dist/artifact.bin"), b"\x00\xff")
                self.assertFalse(any(name.startswith(".git/") for name in names))
                self.assertFalse(any(name.startswith("node_modules/") for name in names))
                self.assertFalse(any("/cache/" in f"/{name}" for name in names))
                self.assertNotIn("outside-link", names)
                self.assertNotIn("pipe", names)
                self.assertNotIn("..\\escape.txt", names)
                self.assertNotIn("C:/drive.txt", names)
                self.assertNotIn("safe.txt:stream", names)
                self.assertTrue(all("\\" not in name for name in names))
                self.assertTrue(all(":" not in name for name in names))
                self.assertFalse(
                    any(part == ".." for name in names for part in Path(name).parts)
                )
                self.assertTrue(all(not name.startswith("/") for name in names))
        finally:
            archive_file.close()

        self.assertGreaterEqual(metadata["fileCount"], 4)
        self.assertGreaterEqual(metadata["skippedCount"], 6)
        self.assertGreater(metadata["archiveBytes"], 0)

    def test_download_all_enforces_file_source_and_archive_limits(self):
        with self.assertRaises(server.RuntimeOperationError) as files:
            server.make_workspace_zip("session-1", max_files=1)
        self.assertEqual(files.exception.code, "export_file_limit_exceeded")

        with self.assertRaises(server.RuntimeOperationError) as source_size:
            server.make_workspace_zip("session-1", max_uncompressed_bytes=1)
        self.assertEqual(source_size.exception.code, "export_size_exceeded")

        with self.assertRaises(server.RuntimeOperationError) as archive_size:
            server.make_workspace_zip("session-1", max_archive_bytes=1)
        self.assertEqual(
            archive_size.exception.code, "export_archive_size_exceeded"
        )

        empty_root = Path(self.temp_dir.name) / "empty-workspace"
        (empty_root / "one").mkdir(parents=True)
        (empty_root / "two").mkdir()
        with self.assertRaises(server.RuntimeOperationError) as entries:
            server.scan_workspace_export(empty_root, max_files=1)
        self.assertEqual(entries.exception.code, "export_file_limit_exceeded")

    def test_download_all_response_is_attachment_and_never_cached(self):
        handler = RecordingHandler()

        server.serve_workspace_zip(handler, "session-1")

        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.headers["content-type"], "application/zip")
        self.assertIn("attachment", handler.headers["content-disposition"])
        self.assertIn("filename*=UTF-8''", handler.headers["content-disposition"])
        self.assertEqual(handler.headers["cache-control"], "private, no-store")
        self.assertEqual(handler.headers["x-content-type-options"], "nosniff")
        self.assertEqual(
            int(handler.headers["content-length"]), len(handler.wfile.getvalue())
        )
        with zipfile.ZipFile(io.BytesIO(handler.wfile.getvalue())) as archive:
            self.assertEqual(archive.read("README.md"), b"# Demo\n")

    def test_file_transfers_are_single_flight_per_session(self):
        with server.workspace_file_transfer("session-1", "test.lock"):
            with self.assertRaises(server.RuntimeOperationError) as upload:
                self.upload("src/busy.txt", b"busy", if_none_match="*")
            self.assertEqual(upload.exception.code, "workspace_transfer_busy")
            self.assertEqual(upload.exception.status, 429)

            with self.assertRaises(server.RuntimeOperationError) as download:
                server.serve_workspace_zip(RecordingHandler(), "session-1")
            self.assertEqual(download.exception.code, "workspace_transfer_busy")
            self.assertEqual(download.exception.status, 429)

        result = self.upload("src/available.txt", b"available", if_none_match="*")
        self.assertEqual(result["path"], "src/available.txt")


if __name__ == "__main__":
    unittest.main()
