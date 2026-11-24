// tests/popup.test.js
//
// Tests for the pure functions in popup/popup.js and for popup.html.
// Plain node, no packages. Run:  node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const popup = require(path.join(ROOT, "popup", "popup.js"));
const { describeRules, nextAllowlist, blockedText, RULES_STALE_DAYS } = popup;

const NOW = new Date(2026, 10, 24); // 24 Nov 2026, local time

test("requiring popup.js in node does not run the chrome code", () => {
  assert.strictEqual(typeof describeRules, "function");
  assert.strictEqual(RULES_STALE_DAYS, 30);
});

test("describeRules: no meta file means built-in rules only", () => {
  const info = describeRules(null, NOW, 30);
  assert.strictEqual(info.text, "Using built-in rules only");
  assert.strictEqual(info.hint, "Run tools/convert.py to build the full lists.");
  assert.strictEqual(info.stale, false);
});

test("describeRules: fresh rules show the date and no hint", () => {
  const info = describeRules({ built: "2026-11-20" }, NOW, 30);
  assert.strictEqual(info.text, "Rules from 2026-11-20");
  assert.strictEqual(info.hint, "");
  assert.strictEqual(info.stale, false);
});

test("describeRules: 29 days is fresh, 30 days is stale", () => {
  const fresh = describeRules({ built: "2026-10-26" }, NOW, 30); // 29 days old
  const old = describeRules({ built: "2026-10-25" }, NOW, 30); // 30 days old
  assert.strictEqual(fresh.stale, false);
  assert.strictEqual(old.stale, true);
  assert.strictEqual(old.text, "Rules from 2026-10-25");
  assert.strictEqual(old.hint, "Over 30 days old. Run tools/convert.py to update.");
});

test("describeRules: the hint follows the staleDays argument", () => {
  const info = describeRules({ built: "2026-11-01" }, NOW, 7);
  assert.strictEqual(info.stale, true);
  assert.strictEqual(info.hint, "Over 7 days old. Run tools/convert.py to update.");
});

test("describeRules: missing or broken date counts as stale", () => {
  for (const meta of [{}, { built: "" }, { built: 5 }, { built: "not a date" }]) {
    const info = describeRules(meta, NOW, 30);
    assert.strictEqual(info.stale, true, JSON.stringify(meta));
    assert.strictEqual(info.text, "Rules from an unknown date", JSON.stringify(meta));
    assert.strictEqual(info.hint, "Run tools/convert.py to update.");
  }
});

test("nextAllowlist: switching blocking off adds the exact site once", () => {
  assert.deepStrictEqual(nextAllowlist([], "example.com", false), ["example.com"]);
  assert.deepStrictEqual(nextAllowlist(["a.com"], "example.com", false), ["a.com", "example.com"]);
  assert.deepStrictEqual(nextAllowlist(["example.com"], "example.com", false), ["example.com"]);
});

test("nextAllowlist: does not add a subdomain when a parent is already allowed", () => {
  assert.deepStrictEqual(nextAllowlist(["example.com"], "news.example.com", false), ["example.com"]);
});

test("nextAllowlist: switching blocking on removes the site", () => {
  assert.deepStrictEqual(nextAllowlist(["a.com", "example.com"], "example.com", true), ["a.com"]);
});

test("nextAllowlist: switching blocking on also removes a parent domain entry", () => {
  const result = nextAllowlist(["example.com", "other.org"], "news.example.com", true);
  assert.deepStrictEqual(result, ["other.org"]);
});

test("nextAllowlist: keeps unrelated and look-alike entries", () => {
  const result = nextAllowlist(["badexample.com", "news.example.com"], "example.com", true);
  assert.deepStrictEqual(result, ["badexample.com", "news.example.com"]);
});

test("nextAllowlist: never changes the list it is given, and copes with bad input", () => {
  const original = ["a.com"];
  nextAllowlist(original, "b.com", false);
  assert.deepStrictEqual(original, ["a.com"]);
  assert.deepStrictEqual(nextAllowlist(undefined, "b.com", false), ["b.com"]);
  assert.deepStrictEqual(nextAllowlist("oops", "b.com", true), []);
});

test("blockedText", () => {
  assert.strictEqual(blockedText(0), "Blocked on this page: 0");
  assert.strictEqual(blockedText(12), "Blocked on this page: 12");
  assert.strictEqual(blockedText(null), "Blocked on this page: not available");
});

test("popup.html has no inline scripts and loads the files in the right order", () => {
  const html = fs.readFileSync(path.join(ROOT, "popup", "popup.html"), "utf8");
  const scripts = html.match(/<script\b[^>]*>/g) || [];
  assert.strictEqual(scripts.length, 2);
  for (const tag of scripts) assert.ok(/\ssrc="/.test(tag), "inline script: " + tag);
  assert.ok(scripts[0].includes('src="../lib/sites.js"'));
  assert.ok(scripts[1].includes('src="popup.js"'));
  assert.ok(html.includes('href="popup.css"'));
  assert.ok(html.includes("Nothing you browse leaves this computer."));
  // The switch is a real checkbox with a label.
  assert.ok(/<input[^>]*type="checkbox"[^>]*id="block-switch"/.test(html));
  assert.ok(html.includes('<label for="block-switch">'));
});

test("every id popup.js looks up exists in popup.html", () => {
  const html = fs.readFileSync(path.join(ROOT, "popup", "popup.html"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "popup", "popup.js"), "utf8");
  const ids = new Set();
  for (const m of js.matchAll(/getElementById\("([^"]+)"\)/g)) ids.add(m[1]);
  assert.ok(ids.size >= 5);
  for (const id of ids) assert.ok(html.includes('id="' + id + '"'), "missing id " + id);
});
