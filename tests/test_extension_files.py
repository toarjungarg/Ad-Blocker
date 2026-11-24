"""Checks on the extension's static files: manifest, icons, rule files.

Run from the repo root:  python3 -m unittest discover -s tests -v
Only the Python standard library is used. Nothing here touches the internet.
"""

import json
import os
import re
import struct
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Chrome's limits (static rules guaranteed per extension, regex rules overall).
MAX_STATIC_RULES = 30000
MAX_REGEX_RULES = 1000

# The permissions the design asks for, and nothing more.
EXPECTED_PERMISSIONS = {
    "declarativeNetRequest",
    "declarativeNetRequestFeedback",
    "storage",
    "scripting",
}
EXPECTED_ICON_SIZES = [16, 32, 48, 128]

VALID_ACTION_TYPES = {
    "block", "allow", "allowAllRequests", "redirect",
    "upgradeScheme", "modifyHeaders",
}
VALID_RESOURCE_TYPES = {
    "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
    "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket",
    "webtransport", "webbundle", "other",
}
# Selector pieces that are not real CSS (they only work in other blockers).
NON_CSS_PSEUDO = [
    ":-abp-", ":has-text(", ":contains(", ":xpath(", ":matches-css",
    ":upward(", ":remove(", ":style(", ":min-text-length(", ":watch-attr(",
    ":matches-path(", ":others(", ":matches-attr(", ":matches-prop(",
    ":nth-ancestor(", ":if(", ":if-not(", ":remove-attr(", ":remove-class(",
]


def path(*parts):
    return os.path.join(ROOT, *parts)


def load_json(*parts):
    with open(path(*parts), "r", encoding="utf-8") as handle:
        return json.load(handle)


def png_size(file_path):
    """Returns (width, height) from a PNG header, or raises AssertionError."""
    with open(file_path, "rb") as handle:
        data = handle.read(33)
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG signature"
    length, chunk = struct.unpack(">I4s", data[8:16])
    assert chunk == b"IHDR" and length == 13, "first chunk is not IHDR"
    return struct.unpack(">II", data[16:24])


def files_named_by_manifest(manifest):
    """Every file path the manifest points at."""
    names = []
    background = manifest.get("background", {})
    if "service_worker" in background:
        names.append(background["service_worker"])
    for script in manifest.get("content_scripts", []):
        names.extend(script.get("js", []))
        names.extend(script.get("css", []))
    for resource in manifest.get("declarative_net_request", {}).get("rule_resources", []):
        names.append(resource["path"])
    action = manifest.get("action", {})
    if "default_popup" in action:
        names.append(action["default_popup"])
    icon = action.get("default_icon", {})
    if isinstance(icon, dict):
        names.extend(icon.values())
    elif isinstance(icon, str):
        names.append(icon)
    names.extend(manifest.get("icons", {}).values())
    if "options_page" in manifest:
        names.append(manifest["options_page"])
    for entry in manifest.get("web_accessible_resources", []):
        for item in entry.get("resources", []):
            if "*" not in item:
                names.append(item)
    return names


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = load_json("manifest.json")

    def test_basic_fields(self):
        m = self.manifest
        self.assertEqual(m["manifest_version"], 3)
        self.assertEqual(m["name"], "Ad-Blocker")
        self.assertRegex(m["version"], r"^\d+\.\d+\.\d+$")
        self.assertTrue(m["description"].strip())
        self.assertLessEqual(len(m["description"]), 132)  # Chrome Web Store limit

    def test_every_named_file_exists(self):
        names = files_named_by_manifest(self.manifest)
        self.assertGreater(len(names), 5)
        for name in names:
            self.assertTrue(os.path.isfile(path(name)), "manifest names a missing file: " + name)

    def test_permissions_match_design(self):
        m = self.manifest
        self.assertEqual(set(m["permissions"]), EXPECTED_PERMISSIONS)
        self.assertEqual(len(m["permissions"]), len(set(m["permissions"])))
        self.assertEqual(m["host_permissions"], ["<all_urls>"])

    def test_service_worker_is_classic_script(self):
        # background.js uses importScripts, which does not work in a module worker.
        background = self.manifest["background"]
        self.assertEqual(background["service_worker"], "background.js")
        self.assertNotEqual(background.get("type"), "module")

    def test_rule_resources(self):
        resources = self.manifest["declarative_net_request"]["rule_resources"]
        self.assertEqual(len(resources), 1)
        self.assertEqual(resources[0]["id"], "base")
        self.assertIs(resources[0]["enabled"], True)
        self.assertEqual(resources[0]["path"], "base-rules.json")

    def test_converted_rules_are_not_a_static_ruleset(self):
        # rules/ is git-ignored, so the manifest must never name it.
        text = json.dumps(self.manifest)
        self.assertNotIn("rules/", text)

    def test_content_script_entry(self):
        # content.js asks the service worker for hiding CSS in every page and frame.
        scripts = self.manifest.get("content_scripts")
        self.assertIsInstance(scripts, list)
        self.assertEqual(len(scripts), 1)
        script = scripts[0]
        self.assertEqual(script.get("matches"), ["<all_urls>"])
        self.assertEqual(script.get("js"), ["content.js"])
        self.assertEqual(script.get("run_at"), "document_start")
        self.assertIs(script.get("all_frames"), True)
        self.assertIs(script.get("match_about_blank"), True)
        self.assertNotIn("css", script)
        self.assertNotIn("world", script)  # must stay in the default isolated world
        self.assertTrue(os.path.isfile(path("content.js")))
        self.assertGreater(os.path.getsize(path("content.js")), 0)

    def test_popup_if_present(self):
        popup = self.manifest.get("action", {}).get("default_popup")
        if popup:
            self.assertTrue(os.path.isfile(path(popup)), popup)

    def test_no_stray_top_level_keys(self):
        allowed = {
            "manifest_version", "name", "version", "description", "permissions",
            "host_permissions", "declarative_net_request", "background",
            "content_scripts", "action", "icons", "minimum_chrome_version",
        }
        self.assertEqual(set(self.manifest) - allowed, set())


class IconTests(unittest.TestCase):
    def test_icons_are_real_pngs_of_the_right_size(self):
        manifest = load_json("manifest.json")
        for key in ("icons", "default_icon"):
            icons = manifest["icons"] if key == "icons" else manifest["action"]["default_icon"]
            self.assertEqual(sorted(int(size) for size in icons), EXPECTED_ICON_SIZES)
            for size, name in icons.items():
                width, height = png_size(path(name))
                self.assertEqual((width, height), (int(size), int(size)), name)

    def test_icon_files_not_empty_or_tiny(self):
        for size in EXPECTED_ICON_SIZES:
            name = "icon%d.png" % size
            self.assertGreater(os.path.getsize(path("icons", name)), 60, name)


class BaseRulesTests(unittest.TestCase):
    def setUp(self):
        self.rules = load_json("base-rules.json")

    def test_is_a_list_with_a_sensible_count(self):
        self.assertIsInstance(self.rules, list)
        self.assertGreaterEqual(len(self.rules), 10)
        self.assertLess(len(self.rules), MAX_STATIC_RULES)

    def test_ids_are_unique_positive_integers(self):
        ids = [rule["id"] for rule in self.rules]
        for rule_id in ids:
            self.assertIs(type(rule_id), int)  # excludes bool and float
            self.assertGreaterEqual(rule_id, 1)
        self.assertEqual(len(ids), len(set(ids)))

    def test_rule_shape(self):
        for rule in self.rules:
            self.assertEqual(set(rule) - {"id", "priority", "action", "condition"}, set(), rule)
            self.assertIs(type(rule["priority"]), int)
            self.assertGreaterEqual(rule["priority"], 1)
            self.assertIn(rule["action"]["type"], VALID_ACTION_TYPES)
            self.assertIsInstance(rule["condition"], dict)
            self.assertTrue(rule["condition"], "empty condition in rule %s" % rule["id"])

    def test_every_rule_is_a_block_rule(self):
        for rule in self.rules:
            self.assertEqual(rule["action"], {"type": "block"}, rule["id"])

    def test_url_filters_are_whole_server_rules(self):
        pattern = re.compile(r"^\|\|[a-z0-9]([a-z0-9.-]*[a-z0-9])?\^$")
        for rule in self.rules:
            url_filter = rule["condition"].get("urlFilter")
            self.assertIsInstance(url_filter, str, rule["id"])
            self.assertRegex(url_filter, pattern, rule["id"])

    def test_no_duplicate_servers(self):
        filters = [rule["condition"]["urlFilter"] for rule in self.rules]
        self.assertEqual(len(filters), len(set(filters)))

    def test_resource_types_are_valid_if_present(self):
        for rule in self.rules:
            for key in ("resourceTypes", "excludedResourceTypes"):
                for kind in rule["condition"].get(key, []):
                    self.assertIn(kind, VALID_RESOURCE_TYPES)

    def test_regex_rule_count_under_limit(self):
        regex_rules = [r for r in self.rules if "regexFilter" in r["condition"]]
        self.assertLessEqual(len(regex_rules), MAX_REGEX_RULES)

    def test_json_has_no_duplicate_keys(self):
        # json.load silently keeps the last duplicate key, so check explicitly.
        def reject_duplicates(pairs):
            keys = [key for key, _ in pairs]
            self.assertEqual(len(keys), len(set(keys)), "duplicate key in " + str(keys))
            return dict(pairs)
        with open(path("base-rules.json"), "r", encoding="utf-8") as handle:
            json.load(handle, object_pairs_hook=reject_duplicates)


class BaseHideTests(unittest.TestCase):
    def selectors(self):
        data = load_json("base-hide.json")
        if isinstance(data, dict):
            self.assertIn("generic", data)
            self.assertEqual(set(data) - {"generic"}, set())
            data = data["generic"]
        self.assertIsInstance(data, list)
        return data

    def test_selectors_are_non_empty_strings(self):
        selectors = self.selectors()
        self.assertGreaterEqual(len(selectors), 10)
        for selector in selectors:
            self.assertIsInstance(selector, str)
            self.assertTrue(selector.strip())
            self.assertEqual(selector, selector.strip())

    def test_no_duplicates(self):
        selectors = self.selectors()
        self.assertEqual(len(selectors), len(set(selectors)))

    def test_no_non_css_pseudo_classes(self):
        for selector in self.selectors():
            for bad in NON_CSS_PSEUDO:
                self.assertNotIn(bad, selector)

    def test_no_css_declarations_inside_selectors(self):
        # background.js adds "{display:none!important}" itself.
        for selector in self.selectors():
            for char in "{};":
                self.assertNotIn(char, selector)
            self.assertNotIn("display:", selector)

    def test_brackets_and_quotes_balanced(self):
        for selector in self.selectors():
            self.assertEqual(selector.count("["), selector.count("]"), selector)
            self.assertEqual(selector.count("("), selector.count(")"), selector)
            self.assertEqual(selector.count('"') % 2, 0, selector)

    def test_selectors_are_not_too_broad(self):
        # A bare tag or "*" would hide real content on every site.
        for selector in self.selectors():
            self.assertNotRegex(selector, r"^[a-z0-9*]+$", selector)


class JsonFilesTests(unittest.TestCase):
    def test_every_json_file_parses(self):
        # The hand-written JSON files that ship with the extension.
        for name in ("manifest.json", "base-rules.json", "base-hide.json"):
            with open(os.path.join(ROOT, name), "r", encoding="utf-8") as handle:
                json.load(handle)


if __name__ == "__main__":
    unittest.main()
