"""Tests for tools/convert.py, the EasyList and EasyPrivacy to Chrome rule converter.

Run from the repo root:
  python3 -m unittest discover -s tests -v
The checks on the real lists read them from lists/ (or the folder named in the
ADBLOCK_LISTS environment variable) and are skipped when the lists are absent:
  ADBLOCK_LISTS=path/to/lists python3 -m unittest tests.test_convert -v

Only the Python standard library is used. Nothing here touches the internet:
the one test that looks at downloading replaces the network call with a stand-in.
"""

import contextlib
import datetime
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import convert  # noqa: E402  (needs the path line above)

CONVERT_SCRIPT = os.path.join(ROOT, "tools", "convert.py")

# Where the real lists live for the slow checks (a folder holding easylist.txt and
# easyprivacy.txt). Relative paths are taken from the current folder, then the repo root.
REAL_LISTS_ENV = "ADBLOCK_LISTS"
REAL_LISTS_DEFAULT = "lists"

# Limits from the design.
CHROME_RULE_LIMIT = 30000
CONVERTER_RULE_LIMIT = 29900
MAX_REAL_RUN_SECONDS = 10
DOMAINS_PER_RULE_LIMIT = 1000

CHROME_RESOURCE_TYPES = {
    "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
    "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport",
    "webbundle", "other",
}
CONDITION_KEYS = {
    "urlFilter", "requestDomains", "initiatorDomains", "excludedInitiatorDomains",
    "domainType", "resourceTypes", "excludedResourceTypes", "isUrlFilterCaseSensitive",
}
ASCII_HOST = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$")
DATE_FORMAT = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Pieces of selector text that must never reach hide.json.
FORBIDDEN_SELECTOR_TEXT = [
    ":-abp-", ":has-text(", ":contains(", ":xpath(", ":matches-css", ":upward(",
    ":remove(", ":style(", ":min-text-length(", ":watch-attr(", ":matches-path(",
    ":others(", ":matches-attr(", ":matches-prop(", ":nth-ancestor(", ":if(",
    ":if-not(", ":remove-attr(", ":remove-class(", "{", "}", "/*", "*/",
]


# ---------------------------------------------------------------- helpers

def convert_text(easylist_lines, easyprivacy_lines=(), max_rules=None):
    """Convert small made-up lists. Returns (rules, hide, meta, report)."""
    with tempfile.TemporaryDirectory() as folder:
        paths = []
        for name, lines in (("easylist.txt", easylist_lines),
                            ("easyprivacy.txt", easyprivacy_lines)):
            path = os.path.join(folder, name)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("\n".join(lines) + "\n")
            paths.append((name, path))
        if max_rules is None:
            return convert.convert_lists(paths)
        return convert.convert_lists(paths, max_rules=max_rules)


def rules_for(lines):
    """Just the network rules for a list of EasyList lines."""
    return convert_text(lines)[0]


def hide_for(lines):
    """Just the hide data for a list of EasyList lines."""
    return convert_text(lines)[1]


def run_main(argv):
    """Run convert.main in this process. Returns (exit_code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = convert.main(argv)
        except SystemExit as exit_signal:
            code = exit_signal.code
    return code, out.getvalue(), err.getvalue()


def write_lists(folder, easylist_lines, easyprivacy_lines):
    for name, lines in (("easylist.txt", easylist_lines),
                        ("easyprivacy.txt", easyprivacy_lines)):
        with open(os.path.join(folder, name), "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")


def read_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


# ---------------------------------------------------------------- grouping

class GroupingTests(unittest.TestCase):

    def test_whole_server_line_becomes_request_domains(self):
        rules = rules_for(["||ads.example.com^"])
        self.assertEqual(len(rules), 1)
        rule = rules[0]
        self.assertEqual(rule["id"], 1)
        self.assertEqual(rule["priority"], 1)
        self.assertEqual(rule["action"], {"type": "block"})
        self.assertEqual(rule["condition"], {
            "requestDomains": ["ads.example.com"],
            "isUrlFilterCaseSensitive": False,
        })

    def test_grouped_rule_has_no_url_filter(self):
        rules = rules_for(["||a.example.com^", "||b.example.com^"])
        for rule in rules:
            self.assertNotIn("urlFilter", rule["condition"])
            self.assertIn("requestDomains", rule["condition"])

    def test_same_options_merge_into_one_rule(self):
        rules = rules_for(["||b.example.org^", "||a.example.com^", "||a.example.com^"])
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["condition"]["requestDomains"],
                         ["a.example.com", "b.example.org"])

    def test_same_third_party_option_merges(self):
        rules = rules_for(["||a.com^$third-party", "||b.com^$third-party"])
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["condition"]["domainType"], "thirdParty")
        self.assertEqual(rules[0]["condition"]["requestDomains"], ["a.com", "b.com"])

    def test_different_options_do_not_merge(self):
        rules = rules_for(["||a.com^$third-party", "||b.com^"])
        self.assertEqual(len(rules), 2)
        by_domain = dict((r["condition"]["requestDomains"][0], r) for r in rules)
        self.assertEqual(by_domain["a.com"]["condition"]["domainType"], "thirdParty")
        self.assertNotIn("domainType", by_domain["b.com"]["condition"])

    def test_block_and_allow_do_not_merge(self):
        rules = rules_for(["||a.com^", "@@||b.com^"])
        self.assertEqual(len(rules), 2)
        self.assertEqual([r["action"]["type"] for r in rules], ["block", "allow"])

    def test_important_does_not_merge_with_normal(self):
        rules = rules_for(["||a.com^$important", "||b.com^$important", "||c.com^"])
        self.assertEqual(len(rules), 2)
        priorities = sorted(r["priority"] for r in rules)
        self.assertEqual(priorities, [1, 3])

    def test_host_is_lowercased(self):
        rules = rules_for(["||ADS.Example.COM^"])
        self.assertEqual(rules[0]["condition"]["requestDomains"], ["ads.example.com"])

    def test_more_than_limit_is_split(self):
        self.assertEqual(convert.MAX_DOMAINS_PER_RULE, DOMAINS_PER_RULE_LIMIT)
        hosts = ["h%04d.example.com" % number for number in range(2500)]
        rules = rules_for(["||%s^" % host for host in hosts])
        sizes = [len(r["condition"]["requestDomains"]) for r in rules]
        self.assertEqual(sizes, [1000, 1000, 500])
        joined = []
        for rule in rules:
            self.assertNotIn("urlFilter", rule["condition"])
            joined.extend(rule["condition"]["requestDomains"])
        self.assertEqual(sorted(joined), sorted(hosts))
        self.assertEqual(len(set(joined)), 2500)

    def test_exactly_limit_is_one_rule(self):
        hosts = ["h%04d.example.com" % number for number in range(1000)]
        rules = rules_for(["||%s^" % host for host in hosts])
        self.assertEqual(len(rules), 1)

    def test_one_over_limit_makes_two_rules(self):
        hosts = ["h%04d.example.com" % number for number in range(1001)]
        rules = rules_for(["||%s^" % host for host in hosts])
        self.assertEqual([len(r["condition"]["requestDomains"]) for r in rules], [1000, 1])

    def test_end_anchor_is_not_grouped(self):
        rules = rules_for(["||example.com^|"])
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["condition"]["urlFilter"], "||example.com^|")
        self.assertNotIn("requestDomains", rules[0]["condition"])

    def test_ip_host_is_not_grouped(self):
        rules = rules_for(["||203.0.113.7^"])
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["condition"]["urlFilter"], "||203.0.113.7^")
        self.assertNotIn("requestDomains", rules[0]["condition"])

    def test_wildcard_host_is_not_grouped(self):
        rules = rules_for(["||ads*.example.com^"])
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["condition"]["urlFilter"], "||ads*.example.com^")

    def test_duplicate_path_rules_are_dropped(self):
        rules = rules_for(["||example.com/ads.js", "||example.com/ads.js"])
        self.assertEqual(len(rules), 1)


# ---------------------------------------------------------------- network lines

class NetworkRuleTests(unittest.TestCase):

    def only_rule(self, line):
        rules = rules_for([line])
        self.assertEqual(len(rules), 1, "expected exactly one rule for " + line)
        return rules[0]

    def test_path_rule_keeps_url_filter_as_written(self):
        rule = self.only_rule("||example.com/ads/*.js^")
        self.assertEqual(rule["condition"]["urlFilter"], "||example.com/ads/*.js^")
        self.assertEqual(rule["priority"], 1)
        self.assertEqual(rule["action"]["type"], "block")

    def test_third_party(self):
        rule = self.only_rule("||example.com/ads.js$third-party")
        self.assertEqual(rule["condition"]["domainType"], "thirdParty")
        self.assertEqual(rule["condition"]["urlFilter"], "||example.com/ads.js")

    def test_third_party_short_name(self):
        rule = self.only_rule("||example.com/ads.js$3p")
        self.assertEqual(rule["condition"]["domainType"], "thirdParty")

    def test_not_third_party(self):
        rule = self.only_rule("||example.com/ads.js$~third-party")
        self.assertEqual(rule["condition"]["domainType"], "firstParty")

    def test_first_party_name(self):
        rule = self.only_rule("||example.com/ads.js$first-party")
        self.assertEqual(rule["condition"]["domainType"], "firstParty")

    def test_script_type(self):
        rule = self.only_rule("||example.com/ads.js$script")
        self.assertEqual(rule["condition"]["resourceTypes"], ["script"])
        self.assertNotIn("excludedResourceTypes", rule["condition"])

    def test_negated_type_only_leaves_resource_types_unset(self):
        rule = self.only_rule("||example.com/ads.js$~image")
        self.assertEqual(rule["condition"]["excludedResourceTypes"], ["image"])
        self.assertNotIn("resourceTypes", rule["condition"])

    def test_subdocument_is_sub_frame(self):
        rule = self.only_rule("||example.com/ads.html$subdocument")
        self.assertEqual(rule["condition"]["resourceTypes"], ["sub_frame"])

    def test_several_types(self):
        rule = self.only_rule("||example.com/ads.js$script,image,xmlhttprequest")
        self.assertEqual(rule["condition"]["resourceTypes"],
                         ["image", "script", "xmlhttprequest"])

    def test_domain_option(self):
        rule = self.only_rule("||example.com/ads.js$domain=a.com|~b.com")
        self.assertEqual(rule["condition"]["initiatorDomains"], ["a.com"])
        self.assertEqual(rule["condition"]["excludedInitiatorDomains"], ["b.com"])

    def test_domain_option_only_excluded(self):
        rule = self.only_rule("||example.com/ads.js$domain=~b.com")
        self.assertNotIn("initiatorDomains", rule["condition"])
        self.assertEqual(rule["condition"]["excludedInitiatorDomains"], ["b.com"])

    def test_match_case(self):
        rule = self.only_rule("||example.com/Ads.js$match-case")
        self.assertIs(rule["condition"]["isUrlFilterCaseSensitive"], True)

    def test_case_flag_is_always_set(self):
        rule = self.only_rule("||example.com/Ads.js")
        self.assertIs(rule["condition"]["isUrlFilterCaseSensitive"], False)

    def test_important_is_priority_three(self):
        rule = self.only_rule("||example.com/ads.js$important")
        self.assertEqual(rule["priority"], 3)
        self.assertEqual(rule["action"]["type"], "block")

    def test_combined_options(self):
        rule = self.only_rule("||example.com/ads.js$script,third-party,domain=a.com,important")
        condition = rule["condition"]
        self.assertEqual(condition["resourceTypes"], ["script"])
        self.assertEqual(condition["domainType"], "thirdParty")
        self.assertEqual(condition["initiatorDomains"], ["a.com"])
        self.assertEqual(rule["priority"], 3)

    def test_exception_is_allow_priority_two(self):
        rule = self.only_rule("@@||example.com/ok.js")
        self.assertEqual(rule["action"], {"type": "allow"})
        self.assertEqual(rule["priority"], 2)
        self.assertEqual(rule["condition"]["urlFilter"], "||example.com/ok.js")

    def test_exception_whole_server_is_grouped(self):
        rule = self.only_rule("@@||ok.example.com^")
        self.assertEqual(rule["action"], {"type": "allow"})
        self.assertEqual(rule["priority"], 2)
        self.assertEqual(rule["condition"]["requestDomains"], ["ok.example.com"])

    def test_exception_with_options(self):
        rule = self.only_rule("@@||example.com/ok.js$script,domain=a.com")
        self.assertEqual(rule["condition"]["resourceTypes"], ["script"])
        self.assertEqual(rule["condition"]["initiatorDomains"], ["a.com"])
        self.assertEqual(rule["priority"], 2)

    def test_allow_rules_come_after_block_rules(self):
        rules = rules_for(["@@||example.com/ok.js", "||example.com/ads.js"])
        self.assertEqual([r["action"]["type"] for r in rules], ["block", "allow"])
        self.assertEqual([r["id"] for r in rules], [1, 2])


class SkippedNetworkLineTests(unittest.TestCase):

    def assert_skipped(self, line):
        rules, _hide, meta, report = convert_text([line])
        self.assertEqual(rules, [], "line should be skipped: " + line)
        self.assertEqual(sum(report["network_skips"].values()), 1,
                         "skip should be counted: " + line)
        self.assertEqual(meta["skipped"], 1)

    def test_unsupported_options_skip_the_line(self):
        for option in ["popup", "document", "csp=script-src 'none'", "redirect=noopjs",
                       "redirect-rule=noopjs", "removeparam=utm_source", "rewrite=abp-resource:blank-js",
                       "generichide", "elemhide", "genericblock", "badfilter", "all",
                       "header=x-test", "inline-script", "denyallow=a.com", "empty", "mp4"]:
            with self.subTest(option=option):
                self.assert_skipped("||example.com/ads.js$" + option)

    def test_unsupported_option_on_exception_skips(self):
        self.assert_skipped("@@||example.com^$generichide")
        self.assert_skipped("@@||example.com^$document")

    def test_unsupported_option_mixed_with_good_one_skips(self):
        self.assert_skipped("||example.com/ads.js$script,popup")

    def test_whole_server_with_unsupported_option_skips(self):
        self.assert_skipped("||example.com^$popup")

    def test_regex_rules_skip(self):
        self.assert_skipped("/ads[0-9]+/")
        self.assert_skipped("/banner[0-9]+/$script")
        self.assert_skipped("@@/ads[0-9]+/")

    def test_plain_path_rules_skip(self):
        self.assert_skipped("/ads/banner.gif")
        self.assert_skipped("-advert-banner.")
        self.assert_skipped("&adtype=")

    def test_non_ascii_skips(self):
        self.assert_skipped("||exämple.com^")
        self.assert_skipped("||example.com/реклама.js")

    def test_comments_and_header_are_ignored_not_skipped(self):
        rules, hide, meta, report = convert_text([
            "[Adblock Plus 2.0]",
            "! Title: Test list",
            "! ||commented.example.com^",
            "",
        ])
        self.assertEqual(rules, [])
        self.assertEqual(hide["generic"], [])
        self.assertEqual(meta["skipped"], 0)
        # Four ignored lines in the first list file, plus one blank line in the second.
        self.assertGreaterEqual(report["ignored"], 4)

    def test_only_good_lines_survive_a_mixed_list(self):
        rules, _hide, meta, _report = convert_text([
            "[Adblock Plus 2.0]",
            "! comment",
            "||good.example.com^",
            "||example.com/x$popup",
            "/regex/",
            "||bad.example.com/y$redirect=noopjs",
        ])
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["condition"]["requestDomains"], ["good.example.com"])
        self.assertEqual(meta["skipped"], 3)


# ---------------------------------------------------------------- hide lines

class HideLineTests(unittest.TestCase):

    def test_generic(self):
        hide = hide_for(["##.ad"])
        self.assertEqual(hide["generic"], [".ad"])
        self.assertEqual(hide["sites"], {})
        self.assertEqual(hide["siteExceptions"], {})

    def test_site_specific(self):
        hide = hide_for(["a.com,b.com##.ad"])
        self.assertEqual(hide["generic"], [])
        self.assertEqual(hide["sites"], {"a.com": [".ad"], "b.com": [".ad"]})

    def test_negated_domain_goes_generic_with_exception(self):
        hide = hide_for(["~a.com##.ad"])
        self.assertEqual(hide["generic"], [".ad"])
        self.assertEqual(hide["siteExceptions"], {"a.com": [".ad"]})
        self.assertEqual(hide["sites"], {})

    def test_two_negated_domains(self):
        hide = hide_for(["~a.com,~b.com##.ad"])
        self.assertEqual(hide["generic"], [".ad"])
        self.assertEqual(sorted(hide["siteExceptions"]), ["a.com", "b.com"])

    def test_mixed_positive_and_negated(self):
        hide = hide_for(["a.com,~b.com##.ad"])
        self.assertEqual(hide["generic"], [])
        self.assertEqual(hide["sites"], {"a.com": [".ad"]})
        self.assertEqual(hide["siteExceptions"], {"b.com": [".ad"]})

    def test_site_exception(self):
        hide = hide_for(["a.com#@#.ad"])
        self.assertEqual(hide["siteExceptions"], {"a.com": [".ad"]})
        self.assertEqual(hide["generic"], [])
        self.assertEqual(hide["sites"], {})

    def test_generic_exception_is_skipped(self):
        rules, hide, meta, report = convert_text(["#@#.ad"])
        self.assertEqual(hide, {"generic": [], "sites": {}, "siteExceptions": {}})
        self.assertEqual(sum(report["hide_skips"].values()), 1)
        self.assertEqual(meta["skipped"], 1)

    def test_unsupported_hide_lines_are_skipped_and_counted(self):
        lines = [
            "a.com#?#.x:-abp-has(.y)",
            "a.com#$#body { overflow: auto !important; }",
            "a.com#@?#.x",
            "a.com#@$#body { x: y }",
            "a.com#%#//scriptlet('abort-on-property-read', 'x')",
            "a.com##+js(abort-on-property-read, x)",
            "##+js(set-constant, x, true)",
            "a.com##^script:has-text(x)",
            "google.*##.x",
            "a.com,google.*##.x",
            "a.com##.x:has-text(foo)",
            "a.com##.x:-abp-has(.y)",
            "a.com##.x:-abp-contains(foo)",
            "a.com##.x:contains(foo)",
            "a.com##.x:xpath(//div)",
            "a.com##.x:matches-css(width: 1px)",
            "a.com##.x:upward(2)",
            "a.com##.x:remove()",
            "a.com##.x:style(color: red)",
            "a.com##.x:min-text-length(5)",
            "a.com##.x:watch-attr(class)",
            "a.com##.x:matches-path(/foo)",
            "a.com##.x:others()",
            "a.com##.x:matches-attr(a=b)",
            "a.com##.x:matches-prop(a=b)",
            "a.com##.x:nth-ancestor(2)",
            "a.com##.x:if(.y)",
            "a.com##.x:if-not(.y)",
            "a.com##.x:remove-attr(a)",
            "a.com##.x:remove-class(a)",
        ]
        for line in lines:
            with self.subTest(line=line):
                rules, hide, meta, report = convert_text([line])
                self.assertEqual(hide, {"generic": [], "sites": {}, "siteExceptions": {}})
                self.assertEqual(rules, [])
                self.assertEqual(sum(report["hide_skips"].values()), 1)

    def test_has_and_not_are_kept(self):
        hide = hide_for(["##div:has(> .ad)", "a.com##.box:not(.keep)"])
        self.assertEqual(hide["generic"], ["div:has(> .ad)"])
        self.assertEqual(hide["sites"], {"a.com": [".box:not(.keep)"]})

    def test_braces_and_css_injection_are_skipped(self):
        lines = [
            "##.a{display:none}",
            "##.a}",
            "##.a{",
            "a.com##.x} body{background:red",
            "##.a /* comment */ .b",
            "##@import url(//example.com/x.css)",
            "a.com##@media screen",
        ]
        for line in lines:
            with self.subTest(line=line):
                _rules, hide, _meta, report = convert_text([line])
                self.assertEqual(hide, {"generic": [], "sites": {}, "siteExceptions": {}})
                self.assertEqual(sum(report["hide_skips"].values()), 1)

    def test_duplicates_removed(self):
        hide = hide_for(["##.ad", "##.ad", "a.com##.x", "a.com##.x"])
        self.assertEqual(hide["generic"], [".ad"])
        self.assertEqual(hide["sites"], {"a.com": [".x"]})

    def test_domains_are_lowercased(self):
        hide = hide_for(["A.COM##.ad"])
        self.assertEqual(hide["sites"], {"a.com": [".ad"]})

    def test_hide_line_does_not_make_a_network_rule(self):
        rules = rules_for(["##.ad", "a.com##.ad", "a.com#@#.ad"])
        self.assertEqual(rules, [])


# ---------------------------------------------------------------- trimming

class TrimmingTests(unittest.TestCase):

    EASYLIST = [
        "@@||el.example/ok.js",        # EasyList allow
        "||el1.example/x",             # EasyList block, single
        "||el2.example/x",             # EasyList block, single
        "||g1.example^",               # EasyList block, grouped (one rule for both)
        "||g2.example^",
    ]
    EASYPRIVACY = [
        "@@||ep.example/ok.js",        # EasyPrivacy allow
        "||ep1.example/x",             # EasyPrivacy block
        "||ep2.example/x",             # EasyPrivacy block
    ]

    def urls(self, rules):
        found = []
        for rule in rules:
            condition = rule["condition"]
            found.append(condition.get("urlFilter") or ",".join(condition["requestDomains"]))
        return found

    def test_no_cut_when_under_limit(self):
        rules, _hide, meta, _report = convert_text(self.EASYLIST, self.EASYPRIVACY)
        self.assertEqual(len(rules), 7)
        self.assertEqual(meta["cut"], 0)
        self.assertEqual(meta["blockRules"], 5)
        self.assertEqual(meta["allowRules"], 2)

    def test_small_limit_keeps_easylist_before_easyprivacy(self):
        rules, _hide, meta, report = convert_text(self.EASYLIST, self.EASYPRIVACY, max_rules=5)
        # Seven rules exist; five fit: all four EasyList rules plus the EasyPrivacy allow rule.
        self.assertEqual(len(rules), 5)
        self.assertEqual(meta["cut"], 2)
        self.assertEqual(report["net_stats"]["cut"], 2)
        found = self.urls(rules)
        self.assertNotIn("||ep1.example/x", found)
        self.assertNotIn("||ep2.example/x", found)
        self.assertIn("||ep.example/ok.js", found)
        self.assertIn("||el.example/ok.js", found)
        self.assertIn("g1.example,g2.example", found)

    def test_ids_are_contiguous_and_block_first(self):
        rules, _hide, meta, _report = convert_text(self.EASYLIST, self.EASYPRIVACY, max_rules=5)
        self.assertEqual([r["id"] for r in rules], [1, 2, 3, 4, 5])
        kinds = [r["action"]["type"] for r in rules]
        self.assertEqual(kinds, ["block", "block", "block", "allow", "allow"])
        self.assertEqual(meta["blockRules"], 3)
        self.assertEqual(meta["allowRules"], 2)
        self.assertEqual(meta["blockRules"] + meta["allowRules"], len(rules))

    def test_tighter_limit_drops_easyprivacy_entirely(self):
        rules, _hide, meta, _report = convert_text(self.EASYLIST, self.EASYPRIVACY, max_rules=4)
        self.assertEqual(len(rules), 4)
        self.assertEqual(meta["cut"], 3)
        # No rule from the EasyPrivacy list (its hosts are ep.example, ep1.example, ep2.example).
        self.assertFalse([t for t in self.urls(rules) if "ep" in t.split(".example")[0]])

    def test_limit_of_three_keeps_allow_first_then_blocks(self):
        rules, _hide, meta, _report = convert_text(self.EASYLIST, self.EASYPRIVACY, max_rules=3)
        self.assertEqual(len(rules), 3)
        self.assertEqual(meta["cut"], 4)
        # The EasyList allow rule is kept first, then the grouped rule and one single.
        kinds = [r["action"]["type"] for r in rules]
        self.assertEqual(kinds.count("allow"), 1)
        self.assertEqual(kinds, ["block", "block", "allow"])
        self.assertEqual([r["id"] for r in rules], [1, 2, 3])

    def test_max_rules_argument_zero_keeps_nothing(self):
        rules, _hide, meta, _report = convert_text(self.EASYLIST, self.EASYPRIVACY, max_rules=0)
        self.assertEqual(rules, [])
        self.assertEqual(meta["cut"], 7)
        self.assertEqual(meta["blockRules"], 0)

    def test_patched_constant_is_honoured_by_main(self):
        # The lead's way to shrink the limit: change the module constant, then run main.
        with tempfile.TemporaryDirectory() as folder:
            lists = os.path.join(folder, "lists")
            out = os.path.join(folder, "out")
            os.makedirs(lists)
            write_lists(lists, self.EASYLIST, self.EASYPRIVACY)
            with mock.patch.object(convert, "MAX_NETWORK_RULES", 5):
                code, _stdout, _stderr = run_main(["--lists", lists, "--out", out])
            self.assertEqual(code, 0)
            rules = read_json(os.path.join(out, "network.json"))
            meta = read_json(os.path.join(out, "meta.json"))
            self.assertEqual(len(rules), 5)
            self.assertEqual(meta["cut"], 2)
            self.assertEqual(meta["blockRules"], 3)


# ---------------------------------------------------------------- whole program

class EndToEndTests(unittest.TestCase):

    EASYLIST = [
        "[Adblock Plus 2.0]",
        "! Title: made-up list",
        "||ads.example.com^",
        "||example.com/banner/*$script,third-party",
        "@@||example.com/banner/ok.js",
        "##.ad-box",
        "a.com##.sponsor",
        "b.com#@#.ad-box",
    ]
    EASYPRIVACY = [
        "[Adblock Plus 2.0]",
        "||track.example.net^$third-party",
        "||example.net/pixel.gif",
    ]

    def test_writes_the_three_files(self):
        with tempfile.TemporaryDirectory() as folder:
            lists = os.path.join(folder, "lists")
            out = os.path.join(folder, "out", "nested")
            os.makedirs(lists)
            write_lists(lists, self.EASYLIST, self.EASYPRIVACY)
            code, stdout, _stderr = run_main(["--lists", lists, "--out", out])
            self.assertEqual(code, 0)
            self.assertEqual(sorted(os.listdir(out)), ["hide.json", "meta.json", "network.json"])

            rules = read_json(os.path.join(out, "network.json"))
            hide = read_json(os.path.join(out, "hide.json"))
            meta = read_json(os.path.join(out, "meta.json"))

            self.assertEqual(len(rules), 5)
            self.assertEqual([r["id"] for r in rules], [1, 2, 3, 4, 5])
            self.assertEqual(hide["generic"], [".ad-box"])
            self.assertEqual(hide["sites"], {"a.com": [".sponsor"]})
            self.assertEqual(hide["siteExceptions"], {"b.com": [".ad-box"]})

            self.assertEqual(meta["blockRules"], 4)
            self.assertEqual(meta["allowRules"], 1)
            self.assertEqual(meta["genericHide"], 1)
            self.assertEqual(meta["siteHide"], 1)
            self.assertEqual(meta["cut"], 0)
            self.assertEqual(meta["skipped"], 0)
            self.assertEqual(meta["sources"], ["easylist.txt", "easyprivacy.txt"])
            self.assertIn("Summary", stdout)

    def test_meta_has_todays_date(self):
        with tempfile.TemporaryDirectory() as folder:
            lists = os.path.join(folder, "lists")
            out = os.path.join(folder, "out")
            os.makedirs(lists)
            write_lists(lists, self.EASYLIST, self.EASYPRIVACY)
            code, _stdout, _stderr = run_main(["--lists", lists, "--out", out])
            self.assertEqual(code, 0)
            built = read_json(os.path.join(out, "meta.json"))["built"]
            self.assertRegex(built, DATE_FORMAT)
            self.assertEqual(built, datetime.date.today().isoformat())

    def test_meta_has_exactly_the_documented_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            lists = os.path.join(folder, "lists")
            out = os.path.join(folder, "out")
            os.makedirs(lists)
            write_lists(lists, self.EASYLIST, self.EASYPRIVACY)
            run_main(["--lists", lists, "--out", out])
            meta = read_json(os.path.join(out, "meta.json"))
            self.assertEqual(sorted(meta), sorted([
                "built", "blockRules", "allowRules", "genericHide", "siteHide",
                "skipped", "cut", "sources"]))

    def test_script_runs_from_another_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            lists = os.path.join(folder, "lists")
            out = os.path.join(folder, "out")
            os.makedirs(lists)
            write_lists(lists, self.EASYLIST, self.EASYPRIVACY)
            done = subprocess.run(
                [sys.executable, CONVERT_SCRIPT, "--lists", lists, "--out", out],
                cwd=folder, capture_output=True, text=True, timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertTrue(os.path.isfile(os.path.join(out, "network.json")))

    def test_missing_list_exits_with_code_one_and_helpful_message(self):
        with tempfile.TemporaryDirectory() as folder:
            lists = os.path.join(folder, "empty")
            out = os.path.join(folder, "out")
            os.makedirs(lists)
            done = subprocess.run(
                [sys.executable, CONVERT_SCRIPT, "--lists", lists, "--out", out],
                capture_output=True, text=True, timeout=60)
            self.assertEqual(done.returncode, 1)
            self.assertIn("easylist.txt", done.stderr)
            self.assertIn("--download", done.stderr)
            self.assertFalse(os.path.exists(out), "nothing should be written on failure")

    def test_one_missing_list_is_enough_to_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            lists = os.path.join(folder, "lists")
            out = os.path.join(folder, "out")
            os.makedirs(lists)
            write_lists(lists, self.EASYLIST, self.EASYPRIVACY)
            os.remove(os.path.join(lists, "easyprivacy.txt"))
            code, _stdout, stderr = run_main(["--lists", lists, "--out", out])
            self.assertEqual(code, 1)
            self.assertIn("easyprivacy.txt", stderr)
            self.assertFalse(os.path.exists(out))

    def test_missing_list_folder_exits_one(self):
        with tempfile.TemporaryDirectory() as folder:
            code, _stdout, stderr = run_main(
                ["--lists", os.path.join(folder, "nope"), "--out", os.path.join(folder, "out")])
            self.assertEqual(code, 1)
            self.assertTrue(stderr)

    def test_no_internet_without_the_flag(self):
        def forbidden(*args, **kwargs):
            raise AssertionError("the network was touched without --download")

        with tempfile.TemporaryDirectory() as folder:
            lists = os.path.join(folder, "lists")
            out = os.path.join(folder, "out")
            os.makedirs(lists)
            write_lists(lists, self.EASYLIST, self.EASYPRIVACY)
            with mock.patch.object(convert.urllib.request, "urlopen", forbidden), \
                    mock.patch.object(convert, "download_lists", forbidden):
                code, _o, _e = run_main(["--lists", lists, "--out", out])
                self.assertEqual(code, 0)
                # Missing lists must also not trigger a download.
                code, _o, _e = run_main(["--lists", os.path.join(folder, "none"),
                                         "--out", os.path.join(folder, "out2")])
                self.assertEqual(code, 1)

    def test_download_flag_uses_the_standin_not_the_internet(self):
        # With the network call replaced, --download should save the stand-in text and convert it.
        class FakeResponse(object):
            def __init__(self, data):
                self.data = data

            def read(self):
                return self.data

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        calls = []

        def fake_urlopen(request, timeout=None):
            calls.append(request.full_url)
            return FakeResponse(b"[Adblock Plus 2.0]\n||fake.example^\n")

        with tempfile.TemporaryDirectory() as folder:
            lists = os.path.join(folder, "lists")
            out = os.path.join(folder, "out")
            with mock.patch.object(convert.urllib.request, "urlopen", fake_urlopen):
                code, _o, _e = run_main(["--lists", lists, "--out", out, "--download"])
            self.assertEqual(code, 0)
            self.assertEqual(len(calls), 2)
            self.assertTrue(os.path.isfile(os.path.join(lists, "easylist.txt")))
            self.assertTrue(os.path.isfile(os.path.join(out, "network.json")))

    def test_failed_download_exits_one_and_keeps_old_file(self):
        def broken_urlopen(request, timeout=None):
            raise OSError("no network in this test")

        with tempfile.TemporaryDirectory() as folder:
            lists = os.path.join(folder, "lists")
            out = os.path.join(folder, "out")
            os.makedirs(lists)
            write_lists(lists, ["||old.example^"], ["||old2.example^"])
            with mock.patch.object(convert.urllib.request, "urlopen", broken_urlopen):
                code, _o, _e = run_main(["--lists", lists, "--out", out, "--download"])
            self.assertEqual(code, 1)
            with open(os.path.join(lists, "easylist.txt"), encoding="utf-8") as handle:
                self.assertIn("||old.example^", handle.read())


# ---------------------------------------------------------------- real lists

def find_real_lists():
    """Return the folder with the real lists, or None when they are not there."""
    wanted = os.environ.get(REAL_LISTS_ENV, REAL_LISTS_DEFAULT)
    candidates = [wanted] if os.path.isabs(wanted) else [
        os.path.abspath(wanted), os.path.join(ROOT, wanted)]
    for folder in candidates:
        if all(os.path.isfile(os.path.join(folder, name)) for name in convert.LIST_FILES):
            return folder
    return None


def check_rule_shape(testcase, rule):
    """A Chrome-shape check, written separately from the converter's own check."""
    testcase.assertIsInstance(rule["id"], int)
    testcase.assertNotIsInstance(rule["id"], bool)
    testcase.assertGreaterEqual(rule["id"], 1)
    testcase.assertIn(rule["priority"], (1, 2, 3))
    testcase.assertEqual(list(rule["action"]), ["type"])
    testcase.assertIn(rule["action"]["type"], ("block", "allow"))

    condition = rule["condition"]
    testcase.assertTrue(set(condition) <= CONDITION_KEYS, "unknown key in " + repr(condition))
    testcase.assertNotIn("regexFilter", condition)
    has_filter = "urlFilter" in condition
    has_domains = "requestDomains" in condition
    testcase.assertTrue(has_filter != has_domains,
                        "needs exactly one of urlFilter and requestDomains: " + repr(rule))
    if has_filter:
        text = condition["urlFilter"]
        testcase.assertIsInstance(text, str)
        testcase.assertTrue(text)
        testcase.assertTrue(all(ord(ch) < 128 for ch in text), "non-ASCII: " + repr(text))
        testcase.assertFalse(text.startswith("||*"), "starts with ||*: " + text)
        testcase.assertFalse(any(ch.isspace() for ch in text), "whitespace: " + repr(text))
    for field in ("requestDomains", "initiatorDomains", "excludedInitiatorDomains"):
        if field in condition:
            names = condition[field]
            testcase.assertIsInstance(names, list)
            testcase.assertTrue(names, "empty " + field)
            for name in names:
                testcase.assertRegex(name, ASCII_HOST)
                testcase.assertNotIn("*", name)
                testcase.assertEqual(name, name.lower())
    testcase.assertLessEqual(len(condition.get("requestDomains", [])), DOMAINS_PER_RULE_LIMIT)
    for field in ("resourceTypes", "excludedResourceTypes"):
        if field in condition:
            testcase.assertTrue(condition[field], "empty " + field)
            for name in condition[field]:
                testcase.assertIn(name, CHROME_RESOURCE_TYPES)
    if "domainType" in condition:
        testcase.assertIn(condition["domainType"], ("firstParty", "thirdParty"))
    if "isUrlFilterCaseSensitive" in condition:
        testcase.assertIsInstance(condition["isUrlFilterCaseSensitive"], bool)


class RealListTests(unittest.TestCase):
    """Slow checks on the real lists. Skipped when the lists are not on this machine."""

    @classmethod
    def setUpClass(cls):
        cls.lists = find_real_lists()
        if cls.lists is None:
            raise unittest.SkipTest("real lists not found (set " + REAL_LISTS_ENV + ")")
        cls.folder = tempfile.mkdtemp(prefix="convert-real-")
        cls.out = os.path.join(cls.folder, "out")
        started = time.perf_counter()
        done = subprocess.run(
            [sys.executable, CONVERT_SCRIPT, "--lists", cls.lists, "--out", cls.out],
            capture_output=True, text=True, timeout=120)
        cls.seconds = time.perf_counter() - started
        cls.returncode = done.returncode
        cls.stdout = done.stdout
        cls.stderr = done.stderr
        if done.returncode == 0:
            cls.rules = read_json(os.path.join(cls.out, "network.json"))
            cls.hide = read_json(os.path.join(cls.out, "hide.json"))
            cls.meta = read_json(os.path.join(cls.out, "meta.json"))

    @classmethod
    def tearDownClass(cls):
        folder = getattr(cls, "folder", None)
        if folder and os.path.isdir(folder):
            shutil.rmtree(folder, ignore_errors=True)

    def test_run_succeeds(self):
        self.assertEqual(self.returncode, 0, self.stderr)

    def test_run_time_is_short(self):
        self.assertLess(self.seconds, MAX_REAL_RUN_SECONDS)

    def test_rule_count_is_under_the_limit(self):
        self.assertLess(len(self.rules), CONVERTER_RULE_LIMIT)
        self.assertLessEqual(len(self.rules), convert.MAX_NETWORK_RULES)
        self.assertLess(len(self.rules), CHROME_RULE_LIMIT)
        self.assertGreater(len(self.rules), 1000)

    def test_ids_are_unique_whole_numbers(self):
        ids = [rule["id"] for rule in self.rules]
        self.assertTrue(all(isinstance(i, int) and not isinstance(i, bool) for i in ids))
        self.assertEqual(len(ids), len(set(ids)))

    def test_ids_are_contiguous_from_one(self):
        self.assertEqual([r["id"] for r in self.rules], list(range(1, len(self.rules) + 1)))

    def test_every_rule_has_chrome_shape(self):
        for rule in self.rules:
            check_rule_shape(self, rule)

    def test_block_ids_come_first(self):
        block_count = self.meta["blockRules"]
        for rule in self.rules:
            if rule["id"] <= block_count:
                self.assertEqual(rule["action"]["type"], "block", rule)
            else:
                self.assertEqual(rule["action"]["type"], "allow", rule)
        self.assertEqual(block_count + self.meta["allowRules"], len(self.rules))

    def test_priorities_match_actions(self):
        for rule in self.rules:
            if rule["action"]["type"] == "allow":
                self.assertEqual(rule["priority"], 2)
            else:
                self.assertIn(rule["priority"], (1, 3))

    def test_no_rule_over_the_domain_limit(self):
        biggest = max(len(r["condition"].get("requestDomains", [])) for r in self.rules)
        self.assertLessEqual(biggest, DOMAINS_PER_RULE_LIMIT)

    def test_grouping_actually_happens(self):
        grouped = [r for r in self.rules if "requestDomains" in r["condition"]]
        domains = sum(len(r["condition"]["requestDomains"]) for r in grouped)
        self.assertGreater(domains, 10000)
        self.assertLess(len(grouped), 500)

    def test_no_main_frame_blocking(self):
        for rule in self.rules:
            if rule["action"]["type"] == "block":
                self.assertNotIn("main_frame", rule["condition"].get("resourceTypes", []))

    def test_hide_file_is_clean(self):
        self.assertEqual(sorted(self.hide), ["generic", "siteExceptions", "sites"])
        self.assertTrue(self.hide["generic"])
        self.assertTrue(self.hide["sites"])

        def check(selectors, where):
            self.assertIsInstance(selectors, list, where)
            for selector in selectors:
                self.assertIsInstance(selector, str, where)
                self.assertTrue(selector.strip(), where)
                self.assertFalse(selector.startswith("@"), where + ": " + selector)
                for bad in FORBIDDEN_SELECTOR_TEXT:
                    self.assertNotIn(bad, selector, where + ": " + selector)

        check(self.hide["generic"], "generic")
        for table in ("sites", "siteExceptions"):
            for domain, selectors in self.hide[table].items():
                self.assertRegex(domain, ASCII_HOST)
                self.assertNotIn("*", domain)
                check(selectors, table + "/" + domain)
        self.assertEqual(len(self.hide["generic"]), len(set(self.hide["generic"])))

    def test_meta_matches_the_files(self):
        meta = self.meta
        self.assertRegex(meta["built"], DATE_FORMAT)
        self.assertEqual(meta["genericHide"], len(self.hide["generic"]))
        self.assertEqual(meta["siteHide"], sum(len(v) for v in self.hide["sites"].values()))
        self.assertEqual(meta["sources"], ["easylist.txt", "easyprivacy.txt"])
        self.assertGreaterEqual(meta["cut"], 0)
        self.assertGreater(meta["skipped"], 0)

    def test_output_is_repeatable(self):
        again = os.path.join(self.folder, "again")
        done = subprocess.run(
            [sys.executable, CONVERT_SCRIPT, "--lists", self.lists, "--out", again],
            capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr)
        try:
            for name in ("network.json", "hide.json"):
                with open(os.path.join(self.out, name), "rb") as first, \
                        open(os.path.join(again, name), "rb") as second:
                    self.assertEqual(first.read(), second.read(), name)
        finally:
            for name in os.listdir(again):
                os.remove(os.path.join(again, name))
            os.rmdir(again)


if __name__ == "__main__":
    unittest.main()
