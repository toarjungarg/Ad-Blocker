// tests/popup_extra.test.js
//
// More edge cases for the pure functions in popup/popup.js.
// Plain node, no packages. Run:  node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { describeRules, nextAllowlist } = require(path.join(ROOT, "popup", "popup.js"));

const NOW = new Date(2026, 10, 24); // 24 Nov 2026, local time

test("describeRules: built today is fresh, about 400 days old is stale", () => {
  assert.strictEqual(describeRules({ built: "2026-11-24" }, NOW, 30).stale, false);
  const old = describeRules({ built: "2025-10-20" }, NOW, 30);
  assert.strictEqual(old.stale, true);
  assert.strictEqual(old.text, "Rules from 2025-10-20");
  assert.ok(old.hint.includes("30"));
});

test("describeRules: a date in the future is not stale (age is never negative)", () => {
  const info = describeRules({ built: "2027-01-01" }, NOW, 30);
  assert.strictEqual(info.stale, false);
  assert.strictEqual(info.text, "Rules from 2027-01-01");
});

test("describeRules: impossible dates count as stale and point at the converter", () => {
  for (const built of ["2026-13-45", "2026-02-30", "yesterday"]) {
    const info = describeRules({ built }, NOW, 30);
    assert.strictEqual(info.stale, true, built);
    assert.strictEqual(info.text, "Rules from an unknown date", built);
    assert.strictEqual(info.hint, "Run tools/convert.py to update.", built);
  }
});

test("describeRules: changing staleDays moves the cut-off and the number in the hint", () => {
  const meta = { built: "2026-11-04" }; // 20 days old
  assert.strictEqual(describeRules(meta, NOW, 30).stale, false);
  assert.strictEqual(describeRules(meta, NOW, 20).stale, true);
  assert.strictEqual(describeRules(meta, NOW, 21).stale, false);
  assert.strictEqual(describeRules(meta, NOW, 20).hint, "Over 20 days old. Run tools/convert.py to update.");
});

test("describeRules: a non-object meta does not crash", () => {
  assert.strictEqual(describeRules("x", NOW, 30).text, "Using built-in rules only");
  assert.strictEqual(describeRules(undefined, NOW, 30).text, "Using built-in rules only");
  assert.doesNotThrow(() => describeRules([], NOW, 30));
});

test("nextAllowlist: www handling", () => {
  assert.deepStrictEqual(nextAllowlist(["www.example.com"], "example.com", false), ["www.example.com"]);
  assert.deepStrictEqual(nextAllowlist(["www.example.com"], "example.com", true), []);
  assert.deepStrictEqual(nextAllowlist([], "www.example.com", false), ["www.example.com"]);
});

test("nextAllowlist: removing keeps look-alikes and ignores junk entries", () => {
  const result = nextAllowlist(["notexample.com", "example.com.evil.net", 5, null, "", "example.com"], "example.com", true);
  assert.deepStrictEqual(result, ["notexample.com", "example.com.evil.net", 5, null, ""]);
});

test("nextAllowlist: turning on when the site is not listed changes nothing", () => {
  assert.deepStrictEqual(nextAllowlist(["a.com"], "b.com", true), ["a.com"]);
});

test("popup.js keeps the stale limit in one named constant", () => {
  const js = fs.readFileSync(path.join(ROOT, "popup", "popup.js"), "utf8");
  assert.strictEqual((js.match(/RULES_STALE_DAYS\s*=/g) || []).length, 1);
  const code = js.replace(/\/\/.*$/gm, "");
  assert.ok(!/>=\s*30\b/.test(code));
  assert.ok(!/\b30\s*days/.test(code));
});
