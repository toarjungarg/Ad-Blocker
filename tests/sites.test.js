// tests/sites.test.js
//
// Tests for lib/sites.js. Plain node, no packages.
// Run:  node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const sites = require(path.join(__dirname, "..", "lib", "sites.js"));
const { siteFromUrl, isAllowlisted, parentDomains, ruleAgeDays, isRulesStale, countBlocked } = sites;

test("lib/sites.js exports exactly the eight helper functions", () => {
  assert.deepStrictEqual(Object.keys(sites).sort(), [
    "countBlocked", "isAllowlisted", "isBlockRule", "isRulesStale", "parentDomains", "ruleAgeDays",
    "shortAddress", "siteFromUrl",
  ]);
  for (const name of Object.keys(sites)) assert.strictEqual(typeof sites[name], "function");
});

// ------------------------------------------------------------ siteFromUrl

test("siteFromUrl: plain and www addresses", () => {
  assert.strictEqual(siteFromUrl("https://example.com/"), "example.com");
  assert.strictEqual(siteFromUrl("https://www.example.com/page?q=1#top"), "example.com");
  assert.strictEqual(siteFromUrl("http://www.example.com"), "example.com");
});

test("siteFromUrl: keeps subdomains, drops port, user info and case", () => {
  assert.strictEqual(siteFromUrl("https://news.example.com/a"), "news.example.com");
  assert.strictEqual(siteFromUrl("https://www.news.example.com/a"), "news.example.com");
  assert.strictEqual(siteFromUrl("http://example.com:8080/x"), "example.com");
  assert.strictEqual(siteFromUrl("https://user:pw@example.com/x"), "example.com");
  assert.strictEqual(siteFromUrl("HTTPS://WWW.Example.COM/Path"), "example.com");
});

test("siteFromUrl: only strips a leading www, not one in the middle", () => {
  assert.strictEqual(siteFromUrl("https://awww.example.com/"), "awww.example.com");
  assert.strictEqual(siteFromUrl("https://example.www.com/"), "example.www.com");
});

test("siteFromUrl: localhost and IP addresses", () => {
  assert.strictEqual(siteFromUrl("http://localhost:8000/test-page/"), "localhost");
  assert.strictEqual(siteFromUrl("http://127.0.0.1:8000/"), "127.0.0.1");
});

test("siteFromUrl: non-web addresses give null", () => {
  for (const url of [
    "chrome://extensions", "chrome-extension://abc/popup.html", "file:///tmp/x.html",
    "about:blank", "ftp://example.com/", "data:text/html,hi", "javascript:alert(1)",
    "view-source:https://example.com/", "edge://settings",
  ]) {
    assert.strictEqual(siteFromUrl(url), null, url);
  }
});

test("siteFromUrl: bad input gives null and never throws", () => {
  for (const value of ["", "not a url", "example.com", "//example.com", null, undefined, 42, {}, []]) {
    assert.strictEqual(siteFromUrl(value), null, String(value));
  }
});

// ------------------------------------------------------------ isAllowlisted

test("isAllowlisted: exact, www and subdomain matches", () => {
  assert.strictEqual(isAllowlisted("example.com", ["example.com"]), true);
  assert.strictEqual(isAllowlisted("www.example.com", ["example.com"]), true);
  assert.strictEqual(isAllowlisted("example.com", ["www.example.com"]), true);
  assert.strictEqual(isAllowlisted("news.example.com", ["example.com"]), true);
  assert.strictEqual(isAllowlisted("a.b.example.com", ["example.com"]), true);
  assert.strictEqual(isAllowlisted("EXAMPLE.com", ["Example.COM"]), true);
});

test("isAllowlisted: a name that only shares a suffix must NOT match", () => {
  assert.strictEqual(isAllowlisted("notexample.com", ["example.com"]), false);
  assert.strictEqual(isAllowlisted("badexample.com", ["example.com"]), false);
  assert.strictEqual(isAllowlisted("www.notexample.com", ["example.com"]), false);
  assert.strictEqual(isAllowlisted("example.com.evil.net", ["example.com"]), false);
  assert.strictEqual(isAllowlisted("example.org", ["example.com"]), false);
  assert.strictEqual(isAllowlisted("com", ["example.com"]), false);
});

test("isAllowlisted: a subdomain entry does not allow its parent", () => {
  assert.strictEqual(isAllowlisted("example.com", ["news.example.com"]), false);
  assert.strictEqual(isAllowlisted("other.example.com", ["news.example.com"]), false);
  assert.strictEqual(isAllowlisted("news.example.com", ["news.example.com"]), true);
});

test("isAllowlisted: several entries, odd entries ignored", () => {
  const list = ["foo.org", "", null, 5, undefined, "example.com"];
  assert.strictEqual(isAllowlisted("www.example.com", list), true);
  assert.strictEqual(isAllowlisted("foo.org", list), true);
  assert.strictEqual(isAllowlisted("bar.net", list), false);
});

test("isAllowlisted: empty or wrong input is false and never throws", () => {
  assert.strictEqual(isAllowlisted("example.com", []), false);
  assert.strictEqual(isAllowlisted("example.com", [""]), false);
  assert.strictEqual(isAllowlisted("example.com", null), false);
  assert.strictEqual(isAllowlisted("example.com", undefined), false);
  assert.strictEqual(isAllowlisted("example.com", "example.com"), false);
  assert.strictEqual(isAllowlisted("", ["example.com"]), false);
  assert.strictEqual(isAllowlisted(null, ["example.com"]), false);
  assert.strictEqual(isAllowlisted(undefined, ["example.com"]), false);
});

// ------------------------------------------------------------ parentDomains

test("parentDomains: walks up to the last two labels", () => {
  assert.deepStrictEqual(parentDomains("a.b.example.com"), ["a.b.example.com", "b.example.com", "example.com"]);
  assert.deepStrictEqual(parentDomains("news.example.com"), ["news.example.com", "example.com"]);
  assert.deepStrictEqual(parentDomains("example.com"), ["example.com"]);
});

test("parentDomains: never returns the bare TLD", () => {
  for (const host of ["a.b.c.example.org", "example.com", "x.y.net"]) {
    for (const item of parentDomains(host)) assert.ok(item.includes("."), item);
  }
});

test("parentDomains: lowercases, handles single words and IPs", () => {
  assert.deepStrictEqual(parentDomains("News.Example.COM"), ["news.example.com", "example.com"]);
  assert.deepStrictEqual(parentDomains("localhost"), ["localhost"]);
  assert.deepStrictEqual(parentDomains("127.0.0.1"), ["127.0.0.1"]);
  assert.deepStrictEqual(parentDomains("[::1]"), ["[::1]"]);
});

test("parentDomains: empty or wrong input gives an empty list", () => {
  assert.deepStrictEqual(parentDomains(""), []);
  assert.deepStrictEqual(parentDomains(null), []);
  assert.deepStrictEqual(parentDomains(undefined), []);
  assert.deepStrictEqual(parentDomains(7), []);
});

// ------------------------------------------------------------ ruleAgeDays

// Months in Date are zero based, so new Date(2026, 10, 24) is 24 November 2026.

test("ruleAgeDays: same day is 0, next day is 1", () => {
  assert.strictEqual(ruleAgeDays("2026-11-24", new Date(2026, 10, 24)), 0);
  assert.strictEqual(ruleAgeDays("2026-11-23", new Date(2026, 10, 24)), 1);
});

test("ruleAgeDays: the time of day does not matter", () => {
  assert.strictEqual(ruleAgeDays("2026-11-24", new Date(2026, 10, 24, 23, 59, 59)), 0);
  assert.strictEqual(ruleAgeDays("2026-11-23", new Date(2026, 10, 24, 0, 0, 1)), 1);
});

test("ruleAgeDays: counts across months and years", () => {
  assert.strictEqual(ruleAgeDays("2026-10-28", new Date(2026, 10, 24)), 27);
  assert.strictEqual(ruleAgeDays("2026-10-25", new Date(2026, 10, 24)), 30);
  assert.strictEqual(ruleAgeDays("2026-01-31", new Date(2026, 2, 1)), 29);
  assert.strictEqual(ruleAgeDays("2025-12-31", new Date(2026, 0, 1)), 1);
  assert.strictEqual(ruleAgeDays("2025-11-24", new Date(2026, 10, 24)), 365);
});

test("ruleAgeDays: leap day", () => {
  assert.strictEqual(ruleAgeDays("2024-02-28", new Date(2024, 2, 1)), 2);
  assert.strictEqual(ruleAgeDays("2023-02-28", new Date(2023, 2, 1)), 1);
});

test("ruleAgeDays: across a daylight saving change stays a whole number", () => {
  // Dates around the March and November clock changes in many countries.
  for (const [built, now] of [
    ["2026-03-01", new Date(2026, 2, 31)],
    ["2026-10-20", new Date(2026, 10, 5)],
  ]) {
    const age = ruleAgeDays(built, now);
    assert.ok(Number.isInteger(age), String(age));
  }
  assert.strictEqual(ruleAgeDays("2026-03-01", new Date(2026, 2, 31)), 30);
  assert.strictEqual(ruleAgeDays("2026-10-20", new Date(2026, 10, 5)), 16);
});

test("ruleAgeDays: a date in the future is 0, never negative", () => {
  assert.strictEqual(ruleAgeDays("2026-12-25", new Date(2026, 10, 24)), 0);
  assert.strictEqual(ruleAgeDays("2030-01-01", new Date(2026, 10, 24)), 0);
});

test("ruleAgeDays: missing or fake dates give null", () => {
  for (const value of [undefined, null, "", "yesterday", "2026-13-01", "2026-02-30", "2026-00-10", "24-11-2026", 20261124]) {
    assert.strictEqual(ruleAgeDays(value, new Date(2026, 10, 24)), null, String(value));
  }
});

test("ruleAgeDays: with no 'now' it uses today", () => {
  const today = new Date();
  const iso = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" +
    String(today.getDate()).padStart(2, "0");
  assert.strictEqual(ruleAgeDays(iso), 0);
});

// ------------------------------------------------------------ isRulesStale

test("isRulesStale: exactly 30 days is stale, 29 is not", () => {
  const now = new Date(2026, 10, 24);
  assert.strictEqual(isRulesStale("2026-10-25", now, 30), true);  // 30 days
  assert.strictEqual(isRulesStale("2026-10-26", now, 30), false); // 29 days
  assert.strictEqual(isRulesStale("2026-10-24", now, 30), true);  // 31 days
  assert.strictEqual(isRulesStale("2026-11-24", now, 30), false); // 0 days
});

test("isRulesStale: uses the number it is given", () => {
  const now = new Date(2026, 10, 24);
  assert.strictEqual(isRulesStale("2026-11-17", now, 7), true);
  assert.strictEqual(isRulesStale("2026-11-18", now, 7), false);
  assert.strictEqual(isRulesStale("2026-11-24", now, 0), true);
});

test("isRulesStale: a missing or broken date counts as stale", () => {
  const now = new Date(2026, 10, 24);
  assert.strictEqual(isRulesStale(undefined, now, 30), true);
  assert.strictEqual(isRulesStale("", now, 30), true);
  assert.strictEqual(isRulesStale("garbage", now, 30), true);
});

test("isRulesStale: a future build date is fresh", () => {
  assert.strictEqual(isRulesStale("2027-01-01", new Date(2026, 10, 24), 30), false);
});

// ------------------------------------------------------------ countBlocked

function match(rulesetId, ruleId) {
  return { rule: { rulesetId, ruleId }, tabId: 1, timeStamp: 1 };
}

test("countBlocked: base rules always count", () => {
  assert.strictEqual(countBlocked([match("base", 1), match("base", 36)], 0), 2);
  assert.strictEqual(countBlocked([match("base", 5000)], 10), 1);
});

test("countBlocked: dynamic block rules 1..blockRuleCount count, allow rules do not", () => {
  const list = [match("_dynamic", 1), match("_dynamic", 100), match("_dynamic", 101), match("_dynamic", 5000)];
  assert.strictEqual(countBlocked(list, 100), 2);
  assert.strictEqual(countBlocked(list, 0), 0);
  assert.strictEqual(countBlocked(list, 5000), 4);
});

test("countBlocked: the allowlist rule and rule id 0 never count", () => {
  const list = [match("_dynamic", 1000000), match("_dynamic", 0), match("_dynamic", -3)];
  assert.strictEqual(countBlocked(list, 29900), 0);
});

test("countBlocked: other rulesets do not count", () => {
  assert.strictEqual(countBlocked([match("_session", 1), match("other", 1), match(undefined, 1)], 100), 0);
});

test("countBlocked: mixed list", () => {
  const list = [
    match("base", 3), match("_dynamic", 7), match("_dynamic", 900), match("_dynamic", 1000000), match("base", 9),
  ];
  assert.strictEqual(countBlocked(list, 500), 3);
});

test("countBlocked: accepts flat items and the whole result object", () => {
  assert.strictEqual(countBlocked([{ rulesetId: "base", ruleId: 2 }, { rulesetId: "_dynamic", ruleId: 4 }], 10), 2);
  const result = { rulesMatchedInfo: [match("base", 1), match("_dynamic", 20)] };
  assert.strictEqual(countBlocked(result, 10), 1);
});

test("countBlocked: empty or wrong input gives 0 and never throws", () => {
  assert.strictEqual(countBlocked([], 10), 0);
  assert.strictEqual(countBlocked(undefined, 10), 0);
  assert.strictEqual(countBlocked(null, 10), 0);
  assert.strictEqual(countBlocked("x", 10), 0);
  assert.strictEqual(countBlocked({}, 10), 0);
  assert.strictEqual(countBlocked([null, undefined, 3, {}], 10), 0);
  // blockRuleCount missing: only base rules can count.
  assert.strictEqual(countBlocked([match("base", 1), match("_dynamic", 1)]), 1);
  assert.strictEqual(countBlocked([match("base", 1), match("_dynamic", 1)], "5"), 1);
});
