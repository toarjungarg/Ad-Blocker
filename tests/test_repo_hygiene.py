"""Repo-wide checks: every JavaScript file parses, and no public file holds a
key, a secret file name or hidden PNG metadata.

Run from the repo root with: python3 -m unittest discover -s tests -v
"""

import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Folders that are git-ignored or are Git's own, so they are not scanned.
SKIP_DIRS = {".git", "rules", "lists", "node_modules", "__pycache__"}

SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
]
SECRET_FILE_NAMES = re.compile(r"(^\.env|^\.dev\.vars|\.pem$|\.key$)")
BINARY_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip"}


def tracked_files():
    """Files Git would publish: the tracked ones plus new ones that are not ignored."""
    git = shutil.which("git")
    if git is None:
        return []
    result = subprocess.run(
        [git, "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    names = result.stdout.decode("utf-8").splitlines()
    return [os.path.join(ROOT, n) for n in names
            if n.split("/")[0] not in SKIP_DIRS and os.path.isfile(os.path.join(ROOT, n))]


def rel(file_path):
    return os.path.relpath(file_path, ROOT)


def read_text(file_path):
    with open(file_path, "rb") as handle:
        return handle.read().decode("utf-8", errors="replace")


class JavaScriptSyntaxTests(unittest.TestCase):
    def test_node_check_on_every_js_file(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node is not installed")
        js_files = [f for f in tracked_files() if f.endswith(".js")]
        self.assertGreaterEqual(len(js_files), 4)
        for file_path in js_files:
            result = subprocess.run([node, "--check", file_path], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(result.returncode, 0, rel(file_path) + ": " + result.stderr.decode("utf-8", "replace"))


class PublicFileSafetyTests(unittest.TestCase):
    def test_no_keys(self):
        for file_path in tracked_files():
            if os.path.splitext(file_path)[1].lower() in BINARY_EXTENSIONS:
                continue
            text = read_text(file_path)
            for pattern in SECRET_PATTERNS:
                self.assertIsNone(pattern.search(text), "%s matches %s" % (rel(file_path), pattern.pattern))

    def test_no_secret_file_names(self):
        for file_path in tracked_files():
            self.assertIsNone(SECRET_FILE_NAMES.search(os.path.basename(file_path)), rel(file_path))

    def test_png_files_have_no_text_metadata(self):
        # PNG text chunks can carry names or paths from the computer that made them.
        for file_path in tracked_files():
            if not file_path.lower().endswith(".png"):
                continue
            with open(file_path, "rb") as handle:
                data = handle.read()
            for chunk in (b"tEXt", b"zTXt", b"iTXt", b"eXIf"):
                self.assertNotIn(chunk, data, "%s has a %s chunk" % (rel(file_path), chunk.decode()))

    def test_gitignore_keeps_built_rules_out(self):
        # rules/ and lists/ hold EasyList material, which has its own licence.
        with open(os.path.join(ROOT, ".gitignore"), "r", encoding="utf-8") as handle:
            lines = [line.strip() for line in handle if line.strip() and not line.startswith("#")]
        for needed in ("rules/", "lists/", ".env", "node_modules/"):
            self.assertIn(needed, lines)


if __name__ == "__main__":
    unittest.main()
