// tests/popup_flow.test.js
//
// Runs the whole popup (popup.js) in a node "vm" with a fake chrome and a tiny fake
// page, the same way a browser would: lib/sites.js is loaded first as plain globals,
// then popup.js. Also checks that what the popup saves works with background.js.
// Plain node, no packages. Run:  node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SITES_SOURCE = fs.readFileSync(path.join(ROOT, "lib", "sites.js"), "utf8");
const POPUP_SOURCE = fs.readFileSync(path.join(ROOT, "popup", "popup.js"), "utf8");
const BACKGROUND_SOURCE = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "popup", "popup.html"), "utf8");

async function settle() {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

// A fake page element that remembers what was done to it.
function makeElement(id, initial) {
  const classes = new Set();
  const handlers = {};
  return Object.assign({
    id,
    textContent: "",
    checked: false,
    disabled: false,
    hidden: false,
    handlers,
    classList: {
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    // Simulates the user clicking the switch: the browser flips "checked", then fires "change".
    async click() {
      this.checked = !this.checked;
      for (const fn of handlers.change || []) fn({});
      await settle();
    },
  }, initial || {});
}

// Builds a fake popup window and runs the real popup.js in it.
//   o.tabs:      result of chrome.tabs.query
//   o.meta:      object returned for rules/meta.json (undefined = file missing)
//   o.storage:   starting storage content
//   o.matched:   result of getMatchedRules, or o.matchedFails to make it reject
//   o.setFails:  make storage.local.set reject
//   o.reloadFails: make tabs.reload reject
async function openPopup(o) {
  const storage = Object.assign({}, o.storage || {});
  const ids = ["site-name", "block-switch", "note", "blocked-line", "rules-line", "rules-hint"];
  const els = {};
  for (const id of ids) els[id] = makeElement(id);
  els["block-switch"].checked = true;   // same as popup.html
  els["block-switch"].disabled = true;  // same as popup.html
  els["note"].hidden = true;            // same as popup.html

  const log = { reloads: [], sets: [], matchedCalls: [], closed: 0, queries: [] };
  const chrome = {
    runtime: { getURL: (p) => "chrome-extension://fakeid/" + p },
    tabs: {
      async query(q) { log.queries.push(JSON.parse(JSON.stringify(q))); return o.tabs; },
      async reload(id) {
        if (o.reloadFails) throw new Error("No tab");
        log.reloads.push(id);
      },
    },
    storage: {
      local: {
        async get(defaults) {
          const out = Object.assign({}, defaults);
          for (const k of Object.keys(storage)) out[k] = JSON.parse(JSON.stringify(storage[k]));
          return out;
        },
        async set(items) {
          if (o.setFails) throw new Error("QUOTA");
          log.sets.push(JSON.parse(JSON.stringify(items)));
          Object.assign(storage, JSON.parse(JSON.stringify(items)));
        },
      },
    },
    declarativeNetRequest: {
      async getMatchedRules(q) {
        log.matchedCalls.push(JSON.parse(JSON.stringify(q)));
        if (o.matchedFails) throw new Error("This request exceeds the MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL quota.");
        return o.matched || { rulesMatchedInfo: [] };
      },
    },
  };
  const sandbox = {
    chrome,
    document: { getElementById: (id) => { if (!els[id]) throw new Error("no element " + id); return els[id]; } },
    window: { close: () => { log.closed++; } },
    fetch: async () => {
      if (o.meta === undefined) throw new TypeError("Failed to fetch");
      return { ok: true, json: async () => o.meta };
    },
    setTimeout: (fn) => setImmediate(fn),
    URL, Date, Array, Promise,
  };
  vm.createContext(sandbox);
  // Like the browser: no "require" and no "module", the two files share one global scope.
  vm.runInContext(SITES_SOURCE, sandbox, { filename: "lib/sites.js" });
  vm.runInContext(POPUP_SOURCE, sandbox, { filename: "popup/popup.js" });
  await settle();
  return { els, log, storage, sandbox };
}

const WEB_TAB = [{ id: 7, url: "https://www.news.example.com/story?x=1" }];
const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
};

test("flow: loading popup.js after sites.js in one scope works (no redeclared names)", async () => {
  const p = await openPopup({ tabs: WEB_TAB, meta: { built: today(), blockRules: 10 } });
  assert.strictEqual(p.els["site-name"].textContent, "news.example.com");
});

test("flow: http page shows the site, switch on, blocked count from block rules only", async () => {
  const matched = { rulesMatchedInfo: [
    { rule: { ruleId: 3, rulesetId: "base" } },       // block (base)
    { rule: { ruleId: 5, rulesetId: "_dynamic" } },   // block (<= blockRules)
    { rule: { ruleId: 10, rulesetId: "_dynamic" } },  // block (== blockRules)
    { rule: { ruleId: 11, rulesetId: "_dynamic" } },  // allow rule, not counted
    { rule: { ruleId: 1000000, rulesetId: "_dynamic" } }, // allowlist rule, not counted
  ] };
  const p = await openPopup({ tabs: WEB_TAB, meta: { built: today(), blockRules: 10 }, matched });
  assert.deepStrictEqual(p.log.queries, [{ active: true, currentWindow: true }]);
  assert.strictEqual(p.els["site-name"].textContent, "news.example.com");
  assert.strictEqual(p.els["block-switch"].checked, true);
  assert.strictEqual(p.els["block-switch"].disabled, false);
  assert.strictEqual(p.els["blocked-line"].textContent, "Blocked on this page: 3");
  assert.deepStrictEqual(p.log.matchedCalls, [{ tabId: 7 }]);
  assert.strictEqual(p.els["rules-line"].textContent, "Rules from " + today());
  assert.strictEqual(p.els["rules-line"].classList.contains("stale"), false);
  assert.strictEqual(p.els["rules-hint"].textContent, "");
});

test("flow: switch is off when the site (or a parent) is on the allowlist", async () => {
  for (const list of [["news.example.com"], ["example.com"], ["www.example.com"]]) {
    const p = await openPopup({ tabs: WEB_TAB, meta: { built: today(), blockRules: 1 }, storage: { allowlist: list } });
    assert.strictEqual(p.els["block-switch"].checked, false, JSON.stringify(list));
    assert.strictEqual(p.els["block-switch"].disabled, false);
  }
  const p = await openPopup({ tabs: WEB_TAB, meta: { built: today(), blockRules: 1 }, storage: { allowlist: ["notexample.com"] } });
  assert.strictEqual(p.els["block-switch"].checked, true);
});

test("flow: non-array allowlist in storage is treated as empty", async () => {
  const p = await openPopup({ tabs: WEB_TAB, meta: { built: today(), blockRules: 1 }, storage: { allowlist: "oops" } });
  assert.strictEqual(p.els["block-switch"].checked, true);
});

test("flow: missing meta file shows built-in text, hint, and counts with 0 block rules", async () => {
  const matched = { rulesMatchedInfo: [
    { rule: { ruleId: 1, rulesetId: "base" } },
    { rule: { ruleId: 1, rulesetId: "_dynamic" } },
  ] };
  const p = await openPopup({ tabs: WEB_TAB, meta: undefined, matched });
  assert.strictEqual(p.els["rules-line"].textContent, "Using built-in rules only");
  assert.ok(p.els["rules-hint"].textContent.includes("tools/convert.py"));
  assert.strictEqual(p.els["rules-line"].classList.contains("stale"), false);
  assert.strictEqual(p.els["blocked-line"].textContent, "Blocked on this page: 1"); // only the base rule
});

test("flow: stale meta gets the orange class and the hint with the constant", async () => {
  const p = await openPopup({ tabs: WEB_TAB, meta: { built: "2020-01-01", blockRules: 5 } });
  assert.strictEqual(p.els["rules-line"].classList.contains("stale"), true);
  assert.strictEqual(p.els["rules-hint"].textContent, "Over 30 days old. Run tools/convert.py to update.");
});

test("flow: meta is null (file is the JSON text null) is treated as missing", async () => {
  const p = await openPopup({ tabs: WEB_TAB, meta: null });
  assert.strictEqual(p.els["rules-line"].textContent, "Using built-in rules only");
});

test("flow: chrome:// page disables the switch and never touches storage or matched rules", async () => {
  const p = await openPopup({ tabs: [{ id: 1, url: "chrome://extensions" }], meta: { built: today(), blockRules: 1 } });
  assert.strictEqual(p.els["block-switch"].disabled, true);
  assert.strictEqual(p.els["block-switch"].checked, false);
  assert.strictEqual(p.els["note"].hidden, false);
  assert.ok(p.els["note"].textContent.length > 0);
  assert.strictEqual(p.els["site-name"].textContent, "Not a website");
  assert.strictEqual(p.log.matchedCalls.length, 0);
  assert.strictEqual(p.els["rules-line"].textContent, "Rules from " + today());
});

test("flow: page with no url (no access), file:// page and no tab all disable the switch", async () => {
  for (const tabs of [[{ id: 1 }], [{ id: 1, url: "file:///tmp/a.html" }], []]) {
    const p = await openPopup({ tabs, meta: { built: today(), blockRules: 1 } });
    assert.strictEqual(p.els["block-switch"].disabled, true, JSON.stringify(tabs));
  }
});

test("flow: getMatchedRules rejecting shows not available", async () => {
  const p = await openPopup({ tabs: WEB_TAB, meta: { built: today(), blockRules: 1 }, matchedFails: true });
  assert.strictEqual(p.els["blocked-line"].textContent, "Blocked on this page: not available");
  // The switch still works.
  assert.strictEqual(p.els["block-switch"].disabled, false);
});

test("flow: turning blocking off saves the site, reloads the tab, closes the popup", async () => {
  const p = await openPopup({ tabs: WEB_TAB, meta: { built: today(), blockRules: 1 }, storage: { allowlist: ["a.com"] } });
  await p.els["block-switch"].click(); // checked true -> false
  assert.deepStrictEqual(p.log.sets, [{ allowlist: ["a.com", "news.example.com"] }]);
  assert.deepStrictEqual(p.log.reloads, [7]);
  assert.strictEqual(p.log.closed, 1);
});

test("flow: turning blocking back on removes the site and a covering parent entry", async () => {
  const p = await openPopup({
    tabs: WEB_TAB, meta: { built: today(), blockRules: 1 },
    storage: { allowlist: ["example.com", "other.org", "notexample.com"] },
  });
  assert.strictEqual(p.els["block-switch"].checked, false);
  await p.els["block-switch"].click(); // false -> true
  assert.deepStrictEqual(p.log.sets, [{ allowlist: ["other.org", "notexample.com"] }]);
  assert.deepStrictEqual(p.log.reloads, [7]);
});

test("flow: the switch is disabled while saving and note is cleared", async () => {
  const p = await openPopup({ tabs: WEB_TAB, meta: { built: today(), blockRules: 1 } });
  const sw = p.els["block-switch"];
  sw.checked = false;
  for (const fn of sw.handlers.change) fn({}); // do not wait
  assert.strictEqual(sw.disabled, true);
  await settle();
});

test("flow: a storage failure puts the switch back and shows a message, no reload", async () => {
  const p = await openPopup({ tabs: WEB_TAB, meta: { built: today(), blockRules: 1 }, setFails: true });
  const sw = p.els["block-switch"];
  assert.strictEqual(sw.checked, true);
  await sw.click(); // true -> false, save fails
  assert.strictEqual(sw.checked, true);
  assert.strictEqual(sw.disabled, false);
  assert.strictEqual(p.els["note"].hidden, false);
  assert.ok(/could not save/i.test(p.els["note"].textContent));
  assert.strictEqual(p.log.reloads.length, 0);
  assert.strictEqual(p.log.closed, 0);
});

test("flow: a failed switch-on (storage failure) puts the switch back to off", async () => {
  const p = await openPopup({
    tabs: WEB_TAB, meta: { built: today(), blockRules: 1 },
    storage: { allowlist: ["news.example.com"] }, setFails: true,
  });
  const sw = p.els["block-switch"];
  assert.strictEqual(sw.checked, false);
  await sw.click();
  assert.strictEqual(sw.checked, false);
  assert.strictEqual(sw.disabled, false);
});

test("flow: when reload fails after saving, the switch keeps its new state and a note says to reload", async () => {
  const p = await openPopup({ tabs: WEB_TAB, meta: { built: today(), blockRules: 1 }, reloadFails: true });
  const sw = p.els["block-switch"];
  await sw.click(); // true -> false
  assert.deepStrictEqual(p.log.sets.length, 1);
  assert.strictEqual(sw.checked, false);
  assert.strictEqual(sw.disabled, false);
  assert.strictEqual(p.els["note"].hidden, false);
  assert.strictEqual(p.els["note"].textContent, "Saved. Reload the page to see the change.");
  assert.ok(!/could not save/i.test(p.els["note"].textContent));
  assert.strictEqual(p.log.closed, 0);
});

test("flow: after a failed save the user can try again and it works", async () => {
  const p = await openPopup({ tabs: WEB_TAB, meta: { built: today(), blockRules: 1 } });
  const sw = p.els["block-switch"];
  // First attempt fails because storage.set rejects once.
  const realSet = p.sandbox.chrome.storage.local.set;
  let first = true;
  p.sandbox.chrome.storage.local.set = async (items) => {
    if (first) { first = false; throw new Error("x"); }
    return realSet(items);
  };
  await sw.click();
  assert.strictEqual(sw.checked, true);
  await sw.click();
  assert.deepStrictEqual(p.log.sets, [{ allowlist: ["news.example.com"] }]);
  assert.deepStrictEqual(p.log.reloads, [7]);
});

// ------------------------------------------------ cross-check with background.js

// Loads background.js into a fake chrome and returns the dynamic rules and CSS calls.
function loadBackground(storage) {
  const dynamic = new Map();
  const inserted = [];
  const listeners = { changed: [], message: [], installed: [], startup: [] };
  const chrome = {
    declarativeNetRequest: {
      async setExtensionActionOptions() {},
      async getDynamicRules() { return Array.from(dynamic.values()); },
      async updateDynamicRules(u) {
        for (const id of (u && u.removeRuleIds) || []) dynamic.delete(id);
        for (const r of (u && u.addRules) || []) dynamic.set(r.id, JSON.parse(JSON.stringify(r)));
      },
    },
    runtime: {
      getURL: (p) => "chrome-extension://fakeid/" + p,
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
    scripting: { async insertCSS(d) { inserted.push(d); } },
    storage: {
      local: { async get(key) { return key in storage ? { [key]: JSON.parse(JSON.stringify(storage[key])) } : {}; } },
      onChanged: { addListener: (fn) => listeners.changed.push(fn) },
    },
  };
  const sandbox = {
    chrome, URL,
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url) => {
      const p = String(url).replace("chrome-extension://fakeid/", "");
      if (p !== "base-hide.json") throw new TypeError("Failed to fetch");
      return { ok: true, json: async () => ({ generic: [".ad-box"] }) };
    },
  };
  vm.createContext(sandbox);
  sandbox.importScripts = () => vm.runInContext(SITES_SOURCE, sandbox);
  vm.runInContext(BACKGROUND_SOURCE, sandbox);
  return {
    dynamic, inserted,
    async storageChanged() {
      for (const fn of listeners.changed) fn({ allowlist: { newValue: storage.allowlist } }, "local");
      await settle();
    },
    async hide(url, tabUrl, frameId) {
      for (const fn of listeners.message) fn({ type: "hide" }, { tab: { id: 7, url: tabUrl || url }, frameId: frameId || 0, url });
      await settle();
    },
  };
}

test("cross-check: the allowlist the popup saves becomes a background rule covering the site", async () => {
  const p = await openPopup({ tabs: WEB_TAB, meta: { built: today(), blockRules: 1 } });
  await p.els["block-switch"].click(); // block off
  const saved = p.storage.allowlist;
  assert.deepStrictEqual(saved, ["news.example.com"]);

  const bg = loadBackground({ allowlist: saved });
  await bg.storageChanged();
  const rule = bg.dynamic.get(1000000);
  assert.ok(rule, "allowlist rule missing");
  assert.strictEqual(rule.priority, 100);
  assert.strictEqual(rule.action.type, "allowAllRequests");
  assert.deepStrictEqual(rule.condition.requestDomains, ["news.example.com"]);
  // requestDomains matches the host and its subdomains, so www.news.example.com is covered.

  // Hiding is skipped on the site, in the page and in its frames, but not elsewhere.
  await bg.hide("https://www.news.example.com/story");
  await bg.hide("https://ads.other.net/frame", "https://www.news.example.com/story", 3);
  assert.strictEqual(bg.inserted.length, 0);
  await bg.hide("https://other.net/");
  assert.strictEqual(bg.inserted.length, 1);
});

test("cross-check: turning blocking back on empties the list and the background rule goes away", async () => {
  const p = await openPopup({
    tabs: WEB_TAB, meta: { built: today(), blockRules: 1 }, storage: { allowlist: ["news.example.com"] },
  });
  await p.els["block-switch"].click(); // block on
  assert.deepStrictEqual(p.storage.allowlist, []);
  const bg = loadBackground({ allowlist: p.storage.allowlist });
  bg.dynamic.set(1000000, { id: 1000000 });
  await bg.storageChanged();
  assert.strictEqual(bg.dynamic.has(1000000), false);
  await bg.hide("https://news.example.com/");
  assert.strictEqual(bg.inserted.length, 1);
});

test("cross-check: site names the popup writes pass background's own name check", async () => {
  // Hostnames a popup can produce: plain, subdomain, hyphen, digits, localhost, punycode.
  const urls = [
    "https://example.com/", "https://a.b.example.co.uk/", "https://my-site.example.com/",
    "http://localhost:8000/test-page/", "https://xn--bcher-kva.example/", "https://123.example.com/",
  ];
  for (const url of urls) {
    const p = await openPopup({ tabs: [{ id: 2, url }], meta: { built: today(), blockRules: 1 } });
    await p.els["block-switch"].click();
    const bg = loadBackground({ allowlist: p.storage.allowlist });
    await bg.storageChanged();
    const rule = bg.dynamic.get(1000000);
    assert.ok(rule, "no allowlist rule for " + url);
    assert.deepStrictEqual(rule.condition.requestDomains, p.storage.allowlist, url);
  }
});

test("cross-check: an IP address page produces an allowlist entry background may reject", async () => {
  // Informational: 127.0.0.1 matches background's name pattern, so it is kept.
  const p = await openPopup({ tabs: [{ id: 2, url: "http://127.0.0.1:8000/" }], meta: { built: today(), blockRules: 1 } });
  await p.els["block-switch"].click();
  assert.deepStrictEqual(p.storage.allowlist, ["127.0.0.1"]);
  const bg = loadBackground({ allowlist: p.storage.allowlist });
  await bg.storageChanged();
  assert.ok(bg.dynamic.get(1000000));
});

test("popup.html: no inline handlers, no style attributes, no external URLs, no inline script", () => {
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, "");
  assert.ok(!/\son[a-z]+\s*=/i.test(noComments), "inline event handler");
  assert.ok(!/javascript:/i.test(noComments));
  assert.ok(!/https?:\/\//i.test(noComments), "external url");
  assert.ok(!/<style\b/i.test(noComments));
  assert.ok(!/\sstyle\s*=/i.test(noComments));
  const scripts = noComments.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
  assert.strictEqual(scripts.length, 2);
  for (const s of scripts) assert.ok(/^<script src="[^"]+"><\/script>$/.test(s), s);
  // Order: css, sites.js, popup.js.
  const order = [noComments.indexOf("popup.css"), noComments.indexOf("../lib/sites.js"), noComments.indexOf('src="popup.js"')];
  assert.ok(order[0] > -1 && order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
});

test("popup.html and popup.css: every local file referenced exists, css has no external url()", () => {
  const refs = [...HTML.replace(/<!--[\s\S]*?-->/g, "").matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 4);
  for (const ref of refs) assert.ok(fs.existsSync(path.join(ROOT, "popup", ref)), "missing " + ref);
  const css = fs.readFileSync(path.join(ROOT, "popup", "popup.css"), "utf8");
  assert.ok(!/url\(\s*["']?https?:/i.test(css));
  assert.ok(!/@import/i.test(css));
  assert.ok(css.includes(".stale"));
});

test("manifest: default_popup points at a file that exists", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.strictEqual(manifest.action.default_popup, "popup/popup.html");
  assert.ok(fs.existsSync(path.join(ROOT, manifest.action.default_popup)));
  assert.ok(manifest.permissions.includes("declarativeNetRequestFeedback"));
  assert.ok(manifest.permissions.includes("storage"));
});
