import hashlib
import importlib.util
import io
import os
import tarfile
import tempfile
import unittest
from pathlib import Path


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

    def test_archive_excludes_regenerable_dependencies(self):
        self.write("src/index.ts", b"export const value = 1;\n")
        self.write("node_modules/pkg/index.js", b"ignored\n")
        self.write(".next/cache/data.bin", b"ignored\n")

        data, manifest = server.make_archive(self.session_id)
        entries = self.archive_entries(data)

        self.assertEqual(set(entries), {"src/index.ts"})
        self.assertEqual(manifest["file_count"], 1)
        self.assertEqual(manifest["skipped_count"], 2)

    def test_manifest_digest_is_computed_from_archived_bytes(self):
        self.write("README.md", b"snapshot\n")
        self.write("src/main.js", b"console.log('snapshot');\n")

        data, manifest = server.make_archive(self.session_id)
        entries = self.archive_entries(data)
        digest = hashlib.sha256()
        for path, content in sorted(entries.items()):
            digest.update(path.encode())
            digest.update(b"\0")
            digest.update(hashlib.sha256(content).hexdigest().encode())
            digest.update(b"\0")

        self.assertEqual(manifest["digest"], digest.hexdigest())

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

    def test_digest_failure_preserves_existing_workspace(self):
        self.write("old.txt", b"keep me\n")
        data, _manifest = server.make_archive(self.session_id)

        with self.assertRaises(server.RuntimeOperationError) as raised:
            server.restore_archive(
                self.session_id,
                data,
                "not-the-real-digest",
                server.sha256_bytes(data),
                server.ARCHIVE_FORMAT,
            )

        self.assertEqual(raised.exception.stage, "restore.verify")
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


if __name__ == "__main__":
    unittest.main()
