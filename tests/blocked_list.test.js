// tests/blocked_list.test.js
//
// Tests for the popup's "what was blocked" dropdown and the dark mode colours:
//   - the helpers in lib/sites.js (isBlockRule, shortAddress),
//   - the pure functions in popup.js (groupBlocked, typeLabel),
//   - background.js saving and clearing each tab's list,
//   - popup.js drawing the list.
// Plain node, no packages. Run:  node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const sites = require(path.join(ROOT, "lib", "sites.js"));
const popup = require(path.join(ROOT, "popup", "popup.js"));
const BACKGROUND_SOURCE = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const SITES_SOURCE = fs.readFileSync(path.join(ROOT, "lib", "sites.js"), "utf8");
const POPUP_SOURCE = fs.readFileSync(path.join(ROOT, "popup", "popup.js"), "utf8");

async function settle() {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

// ------------------------------------------------------------ isBlockRule

test("isBlockRule: base rules and dynamic 1..count are blocks, nothing else", () => {
  assert.strictEqual(sites.isBlockRule({ rulesetId: "base", ruleId: 3 }, 0), true);
  assert.strictEqual(sites.isBlockRule({ rulesetId: "_dynamic", ruleId: 1 }, 10), true);
  assert.strictEqual(sites.isBlockRule({ rulesetId: "_dynamic", ruleId: 10 }, 10), true);
  assert.strictEqual(sites.isBlockRule({ rulesetId: "_dynamic", ruleId: 11 }, 10), false); // allow rule
  assert.strictEqual(sites.isBlockRule({ rulesetId: "_dynamic", ruleId: 1000000 }, 29900), false); // allowlist
  assert.strictEqual(sites.isBlockRule({ rulesetId: "_session", ruleId: 1 }, 10), false);
  for (const bad of [null, undefined, "x", 5]) assert.strictEqual(sites.isBlockRule(bad, 10), false);
});

// ------------------------------------------------------------ shortAddress

test("shortAddress: keeps site and path, drops www, query and hash", () => {
  assert.deepStrictEqual(
    sites.shortAddress("https://www.github.com/_private/browser/stats?id=9#x"),
    { host: "github.com", path: "/_private/browser/stats" }
  );
  assert.deepStrictEqual(sites.shortAddress("http://ads.example.com"), { host: "ads.example.com", path: "/" });
});

test("shortAddress: non-web or broken addresses give null", () => {
  for (const bad of ["chrome://settings", "data:text/plain,hi", "not a url", "", null, 5]) {
    assert.strictEqual(sites.shortAddress(bad), null, String(bad));
  }
});

// ------------------------------------------------------------ groupBlocked

test("groupBlocked: groups by site, busiest site and address first", () => {
  const groups = popup.groupBlocked([
    { host: "a.com", path: "/x", type: "script", count: 1 },
    { host: "b.com", path: "/stats", type: "ping", count: 4 },
    { host: "a.com", path: "/y", type: "xmlhttprequest", count: 2 },
  ]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(groups)), [
    { host: "b.com", total: 4, items: [{ path: "/stats", type: "ping", count: 4 }] },
    { host: "a.com", total: 3, items: [
      { path: "/y", type: "data", count: 2 },
      { path: "/x", type: "script", count: 1 },
    ] },
  ]);
});

test("groupBlocked: ties are sorted by site name", () => {
  const groups = popup.groupBlocked([
    { host: "z.com", path: "/", count: 1 },
    { host: "m.com", path: "/", count: 1 },
  ]);
  assert.deepStrictEqual(groups.map((g) => g.host), ["m.com", "z.com"]);
});

test("groupBlocked: broken input is skipped and never throws", () => {
  assert.deepStrictEqual(popup.groupBlocked(undefined), []);
  assert.deepStrictEqual(popup.groupBlocked("x"), []);
  const groups = popup.groupBlocked([null, 3, { host: 1, path: "/" }, { host: "a.com" }, { host: "a.com", path: "/", count: -2 }]);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].total, 1); // a bad count counts as 1
});

test("typeLabel: plain words for Chrome's request types", () => {
  assert.strictEqual(popup.typeLabel("xmlhttprequest"), "data");
  assert.strictEqual(popup.typeLabel("sub_frame"), "frame");
  assert.strictEqual(popup.typeLabel("script"), "script");
  assert.strictEqual(popup.typeLabel(undefined), "other");
  assert.strictEqual(popup.typeLabel("constructor"), "constructor"); // not something built into JavaScript
});

// ------------------------------------------------------------ background.js

// A fake Chrome with session storage, the debug event and the tab events.
function loadBackground(options) {
  options = options || {};
  const session = {};
  const listeners = { debug: [], updated: [], removed: [] };
  const noop = { addListener() {} };
  const chrome = {
    declarativeNetRequest: {
      async setExtensionActionOptions() {},
      async getDynamicRules() { return []; },
      async updateDynamicRules() {},
      onRuleMatchedDebug: options.noDebug ? undefined : { addListener: (fn) => listeners.debug.push(fn) },
    },
    runtime: { getURL: (p) => "chrome-extension://fakeid/" + p, onInstalled: noop, onStartup: noop, onMessage: noop },
    scripting: { async insertCSS() {} },
    storage: {
      local: { async get() { return {}; } },
      session: {
        async get(key) {
          const out = {};
          if (key in session) out[key] = JSON.parse(JSON.stringify(session[key]));
          return out;
        },
        async set(items) { Object.assign(session, JSON.parse(JSON.stringify(items))); },
        async remove(key) { delete session[key]; },
      },
      onChanged: noop,
    },
    tabs: {
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
    },
  };
  const meta = options.meta === undefined ? { blockRules: 100 } : options.meta;
  const sandbox = {
    chrome,
    console: { log() {}, warn() {}, error() {} },
    URL,
    fetch: async (url) => {
      if (String(url).endsWith("rules/meta.json") && meta !== null) return { ok: true, json: async () => meta };
      throw new TypeError("Failed to fetch");
    },
  };
  vm.createContext(sandbox);
  sandbox.importScripts = () => vm.runInContext(SITES_SOURCE, sandbox);
  vm.runInContext(BACKGROUND_SOURCE, sandbox);
  return {
    session, listeners,
    match: async (url, ruleId, rulesetId, tabId, type) => {
      for (const fn of listeners.debug) {
        fn({ request: { url, tabId, type: type || "script" }, rule: { ruleId, rulesetId: rulesetId || "_dynamic" } });
      }
      await settle();
    },
  };
}

test("background: block matches are saved per tab, repeats raise the count", async () => {
  const bg = loadBackground();
  await bg.match("https://github.com/_private/browser/stats?a=1", 50, "_dynamic", 4, "ping");
  await bg.match("https://github.com/_private/browser/stats?a=2", 50, "_dynamic", 4, "ping");
  await bg.match("https://ads.example.com/x.js", 2, "base", 9);
  assert.deepStrictEqual(bg.session["blocked:4"], [
    { host: "github.com", path: "/_private/browser/stats", type: "ping", count: 2 },
  ]);
  assert.deepStrictEqual(bg.session["blocked:9"], [
    { host: "ads.example.com", path: "/x.js", type: "script", count: 1 },
  ]);
});

test("background: many matches at once are all counted (no lost updates)", async () => {
  const bg = loadBackground();
  for (let i = 0; i < 25; i++) {
    bg.listeners.debug[0]({ request: { url: "https://t.com/p", tabId: 1, type: "ping" }, rule: { ruleId: 1, rulesetId: "_dynamic" } });
  }
  await settle();
  assert.strictEqual(bg.session["blocked:1"][0].count, 25);
});

test("background: allow rules, non-tab requests and non-web addresses are not saved", async () => {
  const bg = loadBackground();
  await bg.match("https://a.com/x", 101, "_dynamic", 1);        // above blockRules: an allow rule
  await bg.match("https://a.com/x", 1000000, "_dynamic", 1);    // the allowlist rule
  await bg.match("https://a.com/x", 1, "_dynamic", -1);         // not from a tab
  await bg.match("chrome-extension://x/y", 1, "_dynamic", 1);   // not a web address
  assert.deepStrictEqual(bg.session, {});
});

test("background: without rules/meta.json only base rules are saved", async () => {
  const bg = loadBackground({ meta: null });
  await bg.match("https://a.com/x", 1, "_dynamic", 1);
  await bg.match("https://a.com/y", 1, "base", 1);
  assert.deepStrictEqual(bg.session["blocked:1"].map((e) => e.path), ["/y"]);
});

test("background: a new page load and a closed tab clear the list", async () => {
  const bg = loadBackground();
  await bg.match("https://a.com/x", 1, "base", 1);
  await bg.match("https://a.com/x", 1, "base", 2);
  bg.listeners.updated[0](1, { title: "x" }); // not a page load: kept
  await settle();
  assert.ok(bg.session["blocked:1"]);
  bg.listeners.updated[0](1, { status: "loading" });
  bg.listeners.removed[0](2);
  await settle();
  assert.deepStrictEqual(bg.session, {});
});

test("background: the list stops growing at MAX_BLOCKED_ENTRIES addresses", async () => {
  const bg = loadBackground();
  const max = /const MAX_BLOCKED_ENTRIES = (\d+);/.exec(BACKGROUND_SOURCE)[1];
  for (let i = 0; i < Number(max) + 5; i++) {
    bg.listeners.debug[0]({ request: { url: "https://t.com/" + i, tabId: 1 }, rule: { ruleId: 1, rulesetId: "base" } });
  }
  await settle();
  assert.strictEqual(bg.session["blocked:1"].length, Number(max));
});

test("background: starts fine without the debug event (store install)", async () => {
  const bg = loadBackground({ noDebug: true });
  assert.strictEqual(bg.listeners.debug.length, 0);
  assert.strictEqual(bg.listeners.updated.length, 1);
});

test("background.js and popup.js use the same storage prefix", () => {
  const re = /const BLOCKED_KEY_PREFIX = "([^"]+)";/;
  assert.strictEqual(re.exec(BACKGROUND_SOURCE)[1], re.exec(POPUP_SOURCE)[1]);
});

// ------------------------------------------------------------ popup.js drawing

function makeElement() {
  return {
    children: [], className: "", hidden: false, open: false, _text: "", handlers: {},
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); },
    set textContent(v) { this._text = String(v); this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(name, fn) { this.handlers[name] = fn; },
  };
}

async function openPopup(o) {
  const ids = ["site-name", "block-switch", "note", "blocked-line", "rules-line", "rules-hint",
    "blocked-details", "blocked-summary", "blocked-list"];
  const els = {};
  for (const id of ids) els[id] = makeElement();
  els["rules-line"].classList = { toggle() {} };
  const chrome = {
    runtime: { getURL: (p) => "chrome-extension://fakeid/" + p },
    tabs: { async query() { return o.tabs; }, async reload() {} },
    storage: {
      local: { async get(d) { return Object.assign({}, d); }, async set() {} },
      session: { async get(key) { return key in (o.session || {}) ? { [key]: o.session[key] } : {}; } },
    },
    declarativeNetRequest: {
      async getMatchedRules() { return { rulesMatchedInfo: [] }; },
      onRuleMatchedDebug: o.noDebug ? undefined : { addListener() {} },
    },
  };
  const sandbox = {
    chrome,
    document: { getElementById: (id) => els[id], createElement: () => makeElement() },
    window: { close() {} },
    fetch: async () => { throw new TypeError("Failed to fetch"); },
    setTimeout: (fn) => setImmediate(fn),
    URL, Date, Array, Promise, Map, Object, Number, Boolean,
  };
  vm.createContext(sandbox);
  vm.runInContext(SITES_SOURCE, sandbox);
  vm.runInContext(POPUP_SOURCE, sandbox);
  await settle();
  return els;
}

const TAB = [{ id: 7, url: "https://github.com/" }];

test("popup: draws one line per site and one per address, as plain text", async () => {
  const els = await openPopup({
    tabs: TAB,
    session: { "blocked:7": [
      { host: "github.com", path: "/_private/browser/stats", type: "ping", count: 5 },
      { host: "evil.com", path: "/<img src=x onerror=alert(1)>", type: "image", count: 1 },
    ] },
  });
  const list = els["blocked-list"];
  assert.strictEqual(list.children.length, 4); // 2 site lines + 2 address rows
  assert.strictEqual(list.children[0].textContent, "github.com (5)");
  assert.strictEqual(list.children[1].textContent, "/_private/browser/stats (ping)x5");
  // The HTML-looking path is kept as text (textContent), not turned into an element.
  assert.strictEqual(list.children[3].children[0].textContent, "/<img src=x onerror=alert(1)> (image)");
});

test("popup: the summary line switches between Show and Hide", async () => {
  const els = await openPopup({ tabs: TAB });
  const details = els["blocked-details"];
  details.open = true;
  details.handlers.toggle();
  assert.strictEqual(els["blocked-summary"].textContent, "Hide what was blocked");
  details.open = false;
  details.handlers.toggle();
  assert.strictEqual(els["blocked-summary"].textContent, "Show what was blocked");
});

test("popup: empty list explains why", async () => {
  let els = await openPopup({ tabs: TAB });
  assert.strictEqual(els["blocked-list"].textContent, "Nothing listed yet. Reload the page to fill this list.");
  els = await openPopup({ tabs: TAB, noDebug: true });
  assert.strictEqual(els["blocked-list"].textContent, "This list only works when the extension is loaded unpacked.");
});

test("popup: the dropdown is hidden on pages that are not websites", async () => {
  const els = await openPopup({ tabs: [{ id: 1, url: "chrome://settings" }] });
  assert.strictEqual(els["blocked-details"].hidden, true);
});

// ------------------------------------------------------------ html and css

test("popup.html has the dropdown in a details element", () => {
  const html = fs.readFileSync(path.join(ROOT, "popup", "popup.html"), "utf8");
  assert.match(html, /<details id="blocked-details"[^>]*>\s*<summary id="blocked-summary">Show what was blocked<\/summary>/);
  assert.match(html, /<div id="blocked-list"/);
});

test("popup.css has dark mode, and every colour outside :root is a variable", () => {
  const css = fs.readFileSync(path.join(ROOT, "popup", "popup.css"), "utf8");
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /color-scheme: light dark/);
  // Remove the :root blocks (where the colours are named), then no "#abc" colours may be left.
  const rest = css.replace(/:root\s*\{[^}]*\}/g, "");
  assert.deepStrictEqual(rest.match(/#[0-9a-fA-F]{3,6}\b/g), null);
});
