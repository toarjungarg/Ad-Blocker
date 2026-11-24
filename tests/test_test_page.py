"""Checks on the local fake-ads test page (test-page/).

There is no browser here, so the page is parsed with html.parser and a small
CSS selector matcher handles the simple selectors used in base-hide.json:
  tag, #id, .class, [attr], [attr=v], [attr^=v], [attr$=v], [attr*=v], [attr~=v]
Selectors that need more than that make the test fail loudly, so a new kind of
selector in base-hide.json forces this matcher to be extended.
"""

import json
import os
import re
import unittest
from html.parser import HTMLParser

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PAGE_DIR = os.path.join(ROOT, "test-page")

VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


def read(*parts):
    with open(os.path.join(ROOT, *parts), "r", encoding="utf-8") as handle:
        return handle.read()


class Element(object):
    def __init__(self, tag, attrs, parent):
        self.tag = tag
        self.attrs = dict((k, v if v is not None else "") for k, v in attrs)
        self.parent = parent

    def ancestors(self):
        node = self.parent
        while node is not None:
            yield node
            node = node.parent


class PageParser(HTMLParser):
    def __init__(self):
        HTMLParser.__init__(self)
        self.elements = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        parent = self.stack[-1] if self.stack else None
        element = Element(tag, attrs, parent)
        self.elements.append(element)
        if tag not in VOID_TAGS:
            self.stack.append(element)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break


def parse_page():
    parser = PageParser()
    parser.feed(read("test-page", "index.html"))
    return parser.elements


ATTR_RE = re.compile(r'\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|\'([^\']*)\'|([^\]\s]*)))?\s*\]')


def parse_simple_selector(selector):
    """Returns (tag or None, [conditions]) or raises ValueError."""
    rest = selector.strip()
    tag = None
    m = re.match(r"^[a-zA-Z][\w-]*", rest)
    if m:
        tag = m.group(0).lower()
        rest = rest[m.end():]
    conditions = []
    while rest:
        if rest[0] == "#":
            m = re.match(r"^#([\w-]+)", rest)
            if not m:
                raise ValueError(selector)
            conditions.append(("id", m.group(1)))
        elif rest[0] == ".":
            m = re.match(r"^\.([\w-]+)", rest)
            if not m:
                raise ValueError(selector)
            conditions.append(("class", m.group(1)))
        elif rest[0] == "[":
            m = ATTR_RE.match(rest)
            if not m:
                raise ValueError(selector)
            value = m.group(3) if m.group(3) is not None else (m.group(4) if m.group(4) is not None else m.group(5))
            conditions.append(("attr", m.group(1).lower(), m.group(2), value))
        else:
            raise ValueError("unsupported selector part: " + selector)
        rest = rest[m.end():]
    if tag is None and not conditions:
        raise ValueError(selector)
    return tag, conditions


def matches(element, selector):
    tag, conditions = parse_simple_selector(selector)
    if tag is not None and element.tag != tag:
        return False
    for cond in conditions:
        if cond[0] == "id":
            if element.attrs.get("id") != cond[1]:
                return False
        elif cond[0] == "class":
            if cond[1] not in element.attrs.get("class", "").split():
                return False
        else:
            _, name, op, value = cond
            if name not in element.attrs:
                return False
            have = element.attrs[name]
            if op is None:
                continue
            if op == "=" and have != value:
                return False
            if op == "^=" and not (value and have.startswith(value)):
                return False
            if op == "$=" and not (value and have.endswith(value)):
                return False
            if op == "*=" and not (value and value in have):
                return False
            if op == "~=" and value not in have.split():
                return False
            if op == "|=" and not (have == value or have.startswith(value + "-")):
                return False
    return True


def hide_selectors():
    data = json.loads(read("base-hide.json"))
    return data["generic"] if isinstance(data, dict) else data


def ad_servers():
    servers = []
    for rule in json.loads(read("base-rules.json")):
        m = re.match(r"^\|\|(.+)\^$", rule["condition"].get("urlFilter", ""))
        if m:
            servers.append(m.group(1))
    return servers


def host_is_ad_server(host, servers):
    host = host.lower()
    return any(host == s or host.endswith("." + s) for s in servers)


class MatcherSelfTests(unittest.TestCase):
    """Makes sure the little matcher used below is itself right."""

    def el(self, tag, **attrs):
        return Element(tag, list(attrs.items()), None)

    def test_matcher_cases(self):
        self.assertTrue(matches(self.el("div", id="div-gpt-ad-1"), 'div[id^="div-gpt-ad"]'))
        self.assertFalse(matches(self.el("span", id="div-gpt-ad-1"), 'div[id^="div-gpt-ad"]'))
        self.assertFalse(matches(self.el("div", id="my-div-gpt-ad"), 'div[id^="div-gpt-ad"]'))
        self.assertTrue(matches(self.el("div", **{"class": "a ad-banner b"}), ".ad-banner"))
        self.assertFalse(matches(self.el("div", **{"class": "ad-banners"}), ".ad-banner"))
        self.assertTrue(matches(self.el("a", href="https://doubleclick.net/x"), 'a[href*="doubleclick.net/"]'))
        self.assertFalse(matches(self.el("a", href="https://example.com/doubleclick.net"), 'a[href*="doubleclick.net/"]'))
        self.assertTrue(matches(self.el("iframe", id="x", src="u"), "iframe"))
        self.assertTrue(matches(self.el("b", id="ad-slot"), "#ad-slot"))
        with self.assertRaises(ValueError):
            matches(self.el("b"), "div > p")


class TestPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.elements = parse_page()
        cls.selectors = hide_selectors()
        cls.servers = ad_servers()

    def test_files_exist(self):
        for name in ("index.html", "test.css", "test.js"):
            self.assertTrue(os.path.isfile(os.path.join(PAGE_DIR, name)), name)

    def test_page_loads_its_own_css_and_js_only(self):
        links = [e.attrs.get("href") for e in self.elements if e.tag == "link"]
        scripts = [e.attrs.get("src") for e in self.elements if e.tag == "script"]
        self.assertEqual(links, ["test.css"])
        self.assertEqual(scripts, ["test.js"])

    def test_all_base_rules_use_urlfilter_the_page_can_read(self):
        # test.js only picks servers out of rules that look like ||host^.
        rules = json.loads(read("base-rules.json"))
        self.assertEqual(len(self.servers), len(rules))

    def test_every_fake_ad_box_matches_a_base_hide_selector(self):
        boxes = [e for e in self.elements if "data-selector" in e.attrs]
        self.assertGreaterEqual(len(boxes), 10)
        for box in boxes:
            declared = box.attrs["data-selector"]
            self.assertIn(declared, self.selectors, "box names a selector that is not in base-hide.json")
            self.assertTrue(matches(box, declared), "box does not match the selector written on it: " + declared)
            hit = [s for s in self.selectors if matches(box, s)]
            self.assertTrue(hit, "no base-hide.json selector matches the box for " + declared)

    def test_every_base_hide_selector_has_a_box(self):
        declared = set(e.attrs["data-selector"] for e in self.elements if "data-selector" in e.attrs)
        self.assertEqual(sorted(set(self.selectors) - declared), [])

    def test_no_two_boxes_test_the_same_selector(self):
        declared = [e.attrs["data-selector"] for e in self.elements if "data-selector" in e.attrs]
        self.assertEqual(len(declared), len(set(declared)))

    def test_real_content_box_exists_and_matches_nothing(self):
        real = [e for e in self.elements if e.attrs.get("id") == "real-content"]
        self.assertEqual(len(real), 1)
        box = real[0]
        self.assertNotIn("data-selector", box.attrs)
        for selector in self.selectors:
            self.assertFalse(matches(box, selector), "real content box matches " + selector)
        # A hidden parent would hide the real box too.
        for ancestor in box.ancestors():
            for selector in self.selectors:
                self.assertFalse(matches(ancestor, selector), "ancestor %s matches %s" % (ancestor.tag, selector))

    def test_nothing_that_is_not_a_fake_ad_matches_a_hide_selector(self):
        # Only boxes with data-selector may be hidden; anything else matching a
        # selector would make the page report wrong results or hide the text.
        for element in self.elements:
            if "data-selector" in element.attrs:
                continue
            for selector in self.selectors:
                self.assertFalse(matches(element, selector),
                                 "<%s> matches %s but is not a fake ad box" % (element.tag, selector))

    def test_fake_ad_boxes_do_not_sit_inside_each_other(self):
        for element in self.elements:
            if "data-selector" in element.attrs:
                for ancestor in element.ancestors():
                    self.assertNotIn("data-selector", ancestor.attrs)

    def test_external_urls_only_go_to_ad_servers(self):
        url_re = re.compile(r"https?://([A-Za-z0-9.-]+)")
        for name in ("index.html", "test.css", "test.js"):
            text = read("test-page", name)
            for host in url_re.findall(text):
                if host in ("localhost", "127.0.0.1"):
                    continue
                self.assertTrue(host_is_ad_server(host, self.servers),
                                "%s mentions a non-ad host: %s" % (name, host))

    def test_html_attributes_that_load_things_point_to_ad_servers_or_local_files(self):
        for element in self.elements:
            for attr in ("src", "href", "action", "data", "poster"):
                value = element.attrs.get(attr)
                if not value or element.tag == "a":
                    continue
                if re.match(r"^(https?:)?//", value):
                    host = re.match(r"^(?:https?:)?//([^/:?#]+)", value).group(1)
                    self.assertTrue(host_is_ad_server(host, self.servers), value)
                else:
                    self.assertNotRegex(value, r"^[a-z][a-z0-9+.-]*:", value)

    def test_links_in_fake_ads_go_to_ad_servers(self):
        for element in self.elements:
            if element.tag == "a" and element.attrs.get("href", "").startswith("http"):
                host = re.match(r"^https?://([^/:?#]+)", element.attrs["href"]).group(1)
                self.assertTrue(host_is_ad_server(host, self.servers), element.attrs["href"])

    def test_page_mentions_what_to_expect(self):
        text = read("test-page", "index.html").lower()
        self.assertIn("extension on", text)
        self.assertIn("extension off", text)
        self.assertIn("http.server", text)

    def test_css_does_not_hide_the_real_box(self):
        css = read("test-page", "test.css")
        block = re.search(r"\.real-content\s*\{([^}]*)\}", css)
        if block:
            self.assertNotRegex(block.group(1), r"display\s*:\s*none")

    def test_css_has_no_imports_or_remote_urls(self):
        css = read("test-page", "test.css")
        self.assertNotIn("@import", css)
        self.assertNotRegex(css, r"url\(\s*['\"]?(https?:)?//")

    def test_test_js_reads_the_right_files(self):
        js = read("test-page", "test.js")
        self.assertIn('"../base-rules.json"', js)
        self.assertIn('"../base-hide.json"', js)


if __name__ == "__main__":
    unittest.main()
