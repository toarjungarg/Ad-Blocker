// tests/background.test.js
//
// Tests for background.js without Chrome. The script is loaded into a node "vm"
// sandbox with a fake chrome object, a fake fetch and a fake importScripts.
// Run:  node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const BACKGROUND_SOURCE = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const SITES_SOURCE = fs.readFileSync(path.join(ROOT, "lib", "sites.js"), "utf8");

const ALLOWLIST_ID = 1000000;

// Waits until all promise work and timers queued so far have finished.
async function settle() {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

// Builds a fake browser, loads background.js into it and returns handles for the test.
//   options.files:       map of "rules/network.json" -> JSON text (a missing key means the file is missing)
//   options.fetchStatus: map of path -> HTTP status to return instead of 200
//   options.storage:     starting content of chrome.storage.local
//   options.dynamic:     rules already saved from an earlier run
//   options.importFails: make importScripts throw
function loadBackground(options) {
  options = options || {};
  const files = options.files || {};
  const storage = Object.assign({}, options.storage || {});
  const dynamicRules = new Map();
  for (const rule of options.dynamic || []) dynamicRules.set(rule.id, rule);

  const logs = { warn: [], log: [], error: [] };
  const calls = []; // every updateDynamicRules argument, in order
  const badges = []; // every setExtensionActionOptions argument
  const listeners = { installed: [], startup: [], changed: [] };

  const dnr = {
    async setExtensionActionOptions(opts) { badges.push(JSON.parse(JSON.stringify(opts))); },
    async getDynamicRules() { return Array.from(dynamicRules.values()); },
    // Mimics Chrome: the whole call fails if any rule is bad or an id is a duplicate.
    async updateDynamicRules(update) {
      calls.push(JSON.parse(JSON.stringify(update)));
      const removeIds = (update && update.removeRuleIds) || [];
      const addRules = (update && update.addRules) || [];
      const after = new Map(dynamicRules);
      for (const id of removeIds) after.delete(id);
      for (const rule of addRules) {
        if (!rule || rule.bad === true) throw new Error("Rule with id " + (rule && rule.id) + " is not valid");
        if (!Number.isInteger(rule.id) || rule.id < 1) throw new Error("Rule has a bad id");
        if (after.has(rule.id)) throw new Error("Rule with id " + rule.id + " does not have a unique ID");
        // Store a copy made in this realm, so deepStrictEqual does not trip over
        // objects that were created inside the vm sandbox.
        after.set(rule.id, JSON.parse(JSON.stringify(rule)));
      }
      dynamicRules.clear();
      for (const [id, rule] of after) dynamicRules.set(id, rule);
    },
  };

  const chrome = {
    declarativeNetRequest: dnr,
    runtime: {
      getURL: (p) => "chrome-extension://fakeid/" + p,
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    },
    storage: {
      local: {
        async get(key) {
          const out = {};
          if (key in storage) out[key] = JSON.parse(JSON.stringify(storage[key]));
          return out;
        },
      },
      onChanged: { addListener: (fn) => listeners.changed.push(fn) },
    },
  };

  async function fakeFetch(url) {
    const p = String(url).replace("chrome-extension://fakeid/", "");
    if (!(p in files)) throw new TypeError("Failed to fetch");
    const status = (options.fetchStatus && options.fetchStatus[p]) || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return JSON.parse(files[p]); },
    };
  }

  const sandbox = {
    chrome,
    fetch: fakeFetch,
    console: {
      log: (...a) => logs.log.push(a.join(" ")),
      warn: (...a) => logs.warn.push(a.join(" ")),
      error: (...a) => logs.error.push(a.join(" ")),
    },
    URL,
  };
  vm.createContext(sandbox);
  sandbox.importScripts = (file) => {
    if (options.importFails) throw new Error("importScripts failed");
    assert.strictEqual(file, "lib/sites.js");
    vm.runInContext(SITES_SOURCE, sandbox, { filename: "lib/sites.js" });
  };

  let loadError = null;
  try {
    vm.runInContext(BACKGROUND_SOURCE, sandbox, { filename: "background.js" });
  } catch (e) {
    loadError = e;
  }

  return {
    sandbox, chrome, logs, calls, badges, listeners, storage, dynamicRules, loadError,
    constant: (name) => vm.runInContext(name, sandbox),
    install: async () => { for (const fn of listeners.installed) fn({ reason: "install" }); await settle(); },
    startup: async () => { for (const fn of listeners.startup) fn(); await settle(); },
    changeStorage: async (key, value, area) => {
      storage[key] = value;
      for (const fn of listeners.changed) fn({ [key]: { newValue: value } }, area || "local");
      await settle();
    },
    ids: () => Array.from(dynamicRules.keys()).sort((a, b) => a - b),
  };
}

function makeRules(count, firstId) {
  const rules = [];
  for (let i = 0; i < count; i++) {
    const id = (firstId || 1) + i;
    rules.push({
      id, priority: 1, action: { type: "block" },
      condition: { urlFilter: "||ads" + id + ".example^", isUrlFilterCaseSensitive: false },
    });
  }
  return rules;
}

// ------------------------------------------------------------ loading

test("loading the script does not throw and adds all three listeners", () => {
  const bg = loadBackground();
  assert.strictEqual(bg.loadError, null);
  assert.strictEqual(bg.listeners.installed.length, 1);
  assert.strictEqual(bg.listeners.startup.length, 1);
  assert.strictEqual(bg.listeners.changed.length, 1);
});

test("constants have the values from the design", () => {
  const bg = loadBackground();
  assert.strictEqual(bg.constant("ALLOWLIST_RULE_ID"), 1000000);
  assert.strictEqual(bg.constant("ALLOWLIST_PRIORITY"), 100);
  assert.strictEqual(bg.constant("RULE_CHUNK_SIZE"), 5000);
  assert.strictEqual(bg.constant("HIDE_CSS"), "{display:none!important}");
  assert.strictEqual(bg.constant("MAX_CONVERTED_RULES"), 29900);
});

test("if lib/sites.js cannot be loaded the worker still starts and still loads rules", async () => {
  const bg = loadBackground({
    importFails: true,
    files: { "rules/network.json": JSON.stringify(makeRules(3)) },
  });
  assert.strictEqual(bg.loadError, null);
  assert.ok(bg.logs.warn.some((line) => line.includes("lib/sites.js")));
  await bg.install();
  assert.deepStrictEqual(bg.ids(), [1, 2, 3]);
});

test("importScripts is called with lib/sites.js and gives the sites helpers", () => {
  const bg = loadBackground();
  assert.strictEqual(vm.runInContext("typeof siteFromUrl", bg.sandbox), "function");
});

// ------------------------------------------------------------ badge

test("install turns on the badge count", async () => {
  const bg = loadBackground();
  await bg.install();
  assert.deepStrictEqual(bg.badges, [{ displayActionCountAsBadgeText: true }]);
});

test("browser start turns on the badge count again and touches no rules", async () => {
  const bg = loadBackground({ dynamic: makeRules(2) });
  await bg.startup();
  assert.deepStrictEqual(bg.badges, [{ displayActionCountAsBadgeText: true }]);
  assert.strictEqual(bg.calls.length, 0);
  assert.deepStrictEqual(bg.ids(), [1, 2]);
});

test("a failing badge call does not stop rules from loading", async () => {
  const bg = loadBackground({ files: { "rules/network.json": JSON.stringify(makeRules(2)) } });
  bg.chrome.declarativeNetRequest.setExtensionActionOptions = async () => { throw new Error("nope"); };
  await bg.install();
  assert.deepStrictEqual(bg.ids(), [1, 2]);
});

// ------------------------------------------------------------ converted rules

test("install replaces old dynamic rules with rules/network.json and keeps the allowlist rule", async () => {
  const allowRule = { id: ALLOWLIST_ID, priority: 100, action: { type: "allowAllRequests" },
    condition: { requestDomains: ["kept.com"], resourceTypes: ["main_frame", "sub_frame"] } };
  const bg = loadBackground({
    dynamic: [...makeRules(5, 1), allowRule],
    files: { "rules/network.json": JSON.stringify(makeRules(3, 1)) },
    storage: { allowlist: ["kept.com"] },
  });
  await bg.install();
  assert.deepStrictEqual(bg.ids(), [1, 2, 3, ALLOWLIST_ID]);
  assert.strictEqual(bg.dynamicRules.get(1).condition.urlFilter, "||ads1.example^");
  assert.deepStrictEqual(bg.dynamicRules.get(ALLOWLIST_ID).condition.requestDomains, ["kept.com"]);
  assert.strictEqual(bg.logs.error.length, 0);
});

test("the allowlist rule is never removed by the rule reload (before the allowlist step)", async () => {
  const allowRule = { id: ALLOWLIST_ID, priority: 100, action: { type: "allowAllRequests" },
    condition: { requestDomains: ["kept.com"], resourceTypes: ["main_frame"] } };
  const bg = loadBackground({
    dynamic: [allowRule, ...makeRules(2)],
    files: { "rules/network.json": JSON.stringify(makeRules(2)) },
    storage: { allowlist: ["kept.com"] },
  });
  await bg.install();
  // Every removeRuleIds list that is not the allowlist rebuild must exclude 1000000.
  const rebuilds = bg.calls.filter((c) => (c.removeRuleIds || []).includes(ALLOWLIST_ID));
  assert.strictEqual(rebuilds.length, 1, "only the allowlist rebuild may touch the allowlist id");
  assert.ok(rebuilds[0].addRules && rebuilds[0].addRules[0].id === ALLOWLIST_ID);
});

test("a converted file containing id 1000000 cannot overwrite the allowlist id", async () => {
  const sneaky = makeRules(2);
  sneaky.push({ id: ALLOWLIST_ID, priority: 1, action: { type: "block" }, condition: { urlFilter: "||x.example^" } });
  const bg = loadBackground({ files: { "rules/network.json": JSON.stringify(sneaky) } });
  await bg.install();
  assert.deepStrictEqual(bg.ids(), [1, 2]);
});

test("rules are sent in chunks of RULE_CHUNK_SIZE", async () => {
  const bg = loadBackground({ files: { "rules/network.json": JSON.stringify(makeRules(12000)) } });
  await bg.install();
  const adds = bg.calls.filter((c) => c.addRules).map((c) => c.addRules.length);
  assert.deepStrictEqual(adds, [5000, 5000, 2000]);
  assert.strictEqual(bg.dynamicRules.size, 12000);
});

test("more than the limit: only the first 29900 are kept, with a warning", async () => {
  const bg = loadBackground({ files: { "rules/network.json": JSON.stringify(makeRules(30500)) } });
  await bg.install();
  assert.strictEqual(bg.dynamicRules.size, 29900);
  assert.ok(bg.dynamicRules.has(1) && bg.dynamicRules.has(29900) && !bg.dynamicRules.has(29901));
  assert.ok(bg.logs.warn.some((line) => line.includes("too many rules")));
});

test("with the file missing, old converted rules are removed and nothing throws", async () => {
  const allowRule = { id: ALLOWLIST_ID, priority: 100, action: { type: "allowAllRequests" },
    condition: { requestDomains: ["kept.com"], resourceTypes: ["main_frame"] } };
  const bg = loadBackground({
    dynamic: [...makeRules(4), allowRule],
    files: {}, // fetch rejects
    storage: { allowlist: ["kept.com"] },
  });
  await bg.install();
  assert.deepStrictEqual(bg.ids(), [ALLOWLIST_ID]);
  assert.strictEqual(bg.logs.error.length, 0);
  assert.ok(bg.logs.log.some((line) => line.includes("no converted rules")));
});

test("with the file answering 404, old converted rules are removed", async () => {
  const bg = loadBackground({
    dynamic: makeRules(4),
    files: { "rules/network.json": "[]" },
    fetchStatus: { "rules/network.json": 404 },
  });
  await bg.install();
  assert.deepStrictEqual(bg.ids(), []);
});

test("with a broken JSON file, old rules are removed and a warning is printed", async () => {
  const bg = loadBackground({ dynamic: makeRules(4), files: { "rules/network.json": "{ not json" } });
  await bg.install();
  assert.deepStrictEqual(bg.ids(), []);
  assert.ok(bg.logs.warn.some((line) => line.includes("not valid JSON")));
});

test("a file that is not a list is ignored with a warning", async () => {
  const bg = loadBackground({ dynamic: makeRules(2), files: { "rules/network.json": '{"a": 1}' } });
  await bg.install();
  assert.deepStrictEqual(bg.ids(), []);
  assert.ok(bg.logs.warn.some((line) => line.includes("should be a list")));
});

test("an empty file means no converted rules", async () => {
  const bg = loadBackground({ dynamic: makeRules(2), files: { "rules/network.json": "[]" } });
  await bg.install();
  assert.deepStrictEqual(bg.ids(), []);
});

test("one bad rule in a chunk is skipped and the others are added", async () => {
  const rules = makeRules(10);
  rules[4].bad = true; // the fake Chrome rejects this one
  const bg = loadBackground({ files: { "rules/network.json": JSON.stringify(rules) } });
  await bg.install();
  assert.deepStrictEqual(bg.ids(), [1, 2, 3, 4, 6, 7, 8, 9, 10]);
  assert.ok(bg.logs.warn.some((line) => line.includes("skipped bad rule id 5")));
  assert.ok(bg.logs.warn.some((line) => line.includes("skipped 1 bad rules in total")));
});

test("a bad rule in the first chunk does not stop later chunks", async () => {
  const rules = makeRules(6000);
  rules[10].bad = true;
  const bg = loadBackground({ files: { "rules/network.json": JSON.stringify(rules) } });
  await bg.install();
  assert.strictEqual(bg.dynamicRules.size, 5999);
  assert.ok(!bg.dynamicRules.has(11));
  assert.ok(bg.dynamicRules.has(6000));
});

test("many bad rules print only a few warnings plus a total", async () => {
  const rules = makeRules(60);
  for (const rule of rules) rule.bad = true;
  const bg = loadBackground({ files: { "rules/network.json": JSON.stringify(rules) } });
  await bg.install();
  assert.strictEqual(bg.dynamicRules.size, 0);
  const perRule = bg.logs.warn.filter((line) => line.includes("skipped bad rule id"));
  assert.strictEqual(perRule.length, bg.constant("MAX_RULE_WARNINGS"));
  assert.ok(bg.logs.warn.some((line) => line.includes("skipped 60 bad rules in total")));
});

test("null entries or duplicate ids inside the file do not crash the load", async () => {
  const rules = makeRules(3);
  rules.push(null);
  rules.push(rules[0]); // duplicate id 1
  const bg = loadBackground({ files: { "rules/network.json": JSON.stringify(rules) } });
  await bg.install();
  assert.strictEqual(bg.loadError, null);
  assert.deepStrictEqual(bg.ids(), [1, 2, 3]);
});

test("running install twice gives the same rules, not duplicates", async () => {
  const bg = loadBackground({ files: { "rules/network.json": JSON.stringify(makeRules(7)) } });
  await bg.install();
  await bg.install();
  assert.deepStrictEqual(bg.ids(), [1, 2, 3, 4, 5, 6, 7]);
});

test("if Chrome fails while listing old rules, install does not throw", async () => {
  const bg = loadBackground({ files: { "rules/network.json": JSON.stringify(makeRules(2)) } });
  bg.chrome.declarativeNetRequest.getDynamicRules = async () => { throw new Error("boom"); };
  await bg.install();
  assert.ok(bg.logs.warn.some((line) => line.includes("could not load converted rules")));
});

// ------------------------------------------------------------ allowlist rule

test("install builds the allowlist rule from storage", async () => {
  const bg = loadBackground({ storage: { allowlist: ["example.com", "news.site.org"] } });
  await bg.install();
  assert.deepStrictEqual(bg.dynamicRules.get(ALLOWLIST_ID), {
    id: ALLOWLIST_ID,
    priority: 100,
    action: { type: "allowAllRequests" },
    condition: { requestDomains: ["example.com", "news.site.org"], resourceTypes: ["main_frame", "sub_frame"] },
  });
});

test("storage change rebuilds the allowlist rule with the exact shape", async () => {
  const bg = loadBackground();
  await bg.install();
  assert.ok(!bg.dynamicRules.has(ALLOWLIST_ID), "no rule while the list is empty");
  await bg.changeStorage("allowlist", ["example.com"]);
  const rule = bg.dynamicRules.get(ALLOWLIST_ID);
  assert.strictEqual(rule.priority, 100);
  assert.strictEqual(rule.action.type, "allowAllRequests");
  assert.deepStrictEqual(rule.condition.requestDomains, ["example.com"]);
  assert.deepStrictEqual(rule.condition.resourceTypes, ["main_frame", "sub_frame"]);
  assert.deepStrictEqual(Object.keys(rule).sort(), ["action", "condition", "id", "priority"]);
});

test("storage change replaces the old allowlist rule (one rule only)", async () => {
  const bg = loadBackground();
  await bg.install();
  await bg.changeStorage("allowlist", ["a.com"]);
  await bg.changeStorage("allowlist", ["a.com", "b.com"]);
  assert.deepStrictEqual(bg.dynamicRules.get(ALLOWLIST_ID).condition.requestDomains, ["a.com", "b.com"]);
  assert.strictEqual(bg.dynamicRules.size, 1);
});

test("emptying the allowlist removes the rule", async () => {
  const bg = loadBackground({ storage: { allowlist: ["a.com"] } });
  await bg.install();
  assert.ok(bg.dynamicRules.has(ALLOWLIST_ID));
  await bg.changeStorage("allowlist", []);
  assert.ok(!bg.dynamicRules.has(ALLOWLIST_ID));
});

test("allowlist entries are cleaned: www removed, lowercased, duplicates and junk dropped", async () => {
  const bg = loadBackground();
  await bg.install();
  await bg.changeStorage("allowlist", ["WWW.Example.com", "example.com", "  foo.org ", "bad entry!", "", 42, null, "-x.com", "a/b.com"]);
  assert.deepStrictEqual(bg.dynamicRules.get(ALLOWLIST_ID).condition.requestDomains, ["example.com", "foo.org"]);
});

test("an allowlist with only junk removes the rule instead of adding an empty one", async () => {
  const bg = loadBackground({ storage: { allowlist: ["a.com"] } });
  await bg.install();
  await bg.changeStorage("allowlist", ["???", 7]);
  assert.ok(!bg.dynamicRules.has(ALLOWLIST_ID));
});

test("a stored value that is not a list is treated as empty", async () => {
  const bg = loadBackground({ storage: { allowlist: ["a.com"] } });
  await bg.install();
  await bg.changeStorage("allowlist", "a.com");
  assert.ok(!bg.dynamicRules.has(ALLOWLIST_ID));
});

test("storage changes for other keys or other storage areas are ignored", async () => {
  const bg = loadBackground();
  await bg.install();
  const before = bg.calls.length;
  await bg.changeStorage("something-else", ["a.com"]);
  await bg.changeStorage("allowlist", ["a.com"], "sync");
  await bg.changeStorage("allowlist", ["a.com"], "session");
  assert.strictEqual(bg.calls.length, before);
  assert.ok(!bg.dynamicRules.has(ALLOWLIST_ID));
});

test("allowlist rule wins over converted block rules by priority", async () => {
  const bg = loadBackground({
    files: { "rules/network.json": JSON.stringify(makeRules(3)) },
    storage: { allowlist: ["a.com"] },
  });
  await bg.install();
  const highestOther = Math.max(...makeRules(3).map((r) => r.priority), 3); // 3 = important block
  assert.ok(bg.dynamicRules.get(ALLOWLIST_ID).priority > highestOther);
});

test("a storage change while the big rule load is running still ends with both done", async () => {
  const bg = loadBackground({ files: { "rules/network.json": JSON.stringify(makeRules(12000)) } });
  for (const fn of bg.listeners.installed) fn({ reason: "install" });
  bg.storage.allowlist = ["late.com"];
  for (const fn of bg.listeners.changed) fn({ allowlist: { newValue: ["late.com"] } }, "local");
  await settle();
  assert.strictEqual(bg.dynamicRules.size, 12001);
  assert.deepStrictEqual(bg.dynamicRules.get(ALLOWLIST_ID).condition.requestDomains, ["late.com"]);
});

test("a failure while setting the allowlist rule does not throw", async () => {
  const bg = loadBackground();
  await bg.install();
  bg.chrome.storage.local.get = async () => { throw new Error("storage down"); };
  await bg.changeStorage("allowlist", ["a.com"]);
  assert.ok(bg.logs.warn.some((line) => line.includes("could not update the allowlist rule")));
});

test("a broken update does not stop the next one (the queue keeps going)", async () => {
  const bg = loadBackground();
  await bg.install();
  const original = bg.chrome.declarativeNetRequest.updateDynamicRules;
  bg.chrome.declarativeNetRequest.updateDynamicRules = async () => { throw new Error("temporary"); };
  await bg.changeStorage("allowlist", ["a.com"]);
  bg.chrome.declarativeNetRequest.updateDynamicRules = original;
  await bg.changeStorage("allowlist", ["b.com"]);
  assert.deepStrictEqual(bg.dynamicRules.get(ALLOWLIST_ID).condition.requestDomains, ["b.com"]);
});
