// tests/testpage.test.js
//
// Runs test-page/test.js in a node "vm" sandbox with a fake page and a fake fetch,
// to check its logic: which servers it requests, how it counts results, and how
// it reports hidden and visible boxes. No browser and no network are used.
// Run:  node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const TEST_JS = fs.readFileSync(path.join(ROOT, "test-page", "test.js"), "utf8");
const BASE_RULES = fs.readFileSync(path.join(ROOT, "base-rules.json"), "utf8");
const BASE_HIDE = fs.readFileSync(path.join(ROOT, "base-hide.json"), "utf8");

async function settle() {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

function fakeElement() {
  return {
    children: [],
    textContent: "",
    className: "",
    attributes: {},
    listeners: {},
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    getAttribute(name) { return this.attributes[name]; },
    matches() { return true; },
  };
}

// options.requestResult(server) -> "blocked" | "loaded" | "hang"
// options.boxes: list of { selector, hidden } fake ad boxes on the page
// options.realHidden: whether the real content box is hidden
// options.files: override the JSON files served for ../base-rules.json and ../base-hide.json
function runPage(options) {
  options = options || {};
  const requested = [];
  const requestResult = options.requestResult || (() => "blocked");
  const files = Object.assign({ "../base-rules.json": BASE_RULES, "../base-hide.json": BASE_HIDE }, options.files || {});

  const byId = {};
  const tbodies = { "#request-table tbody": fakeElement(), "#hide-table tbody": fakeElement() };
  for (const id of ["request-summary", "hide-summary", "hide-warnings", "recheck-button", "real-content"]) {
    byId[id] = fakeElement();
  }
  const boxes = (options.boxes || []).map((spec) => {
    const el = fakeElement();
    el.attributes["data-selector"] = spec.selector;
    el.hiddenFlag = spec.hidden;
    el.matches = () => !spec.notMatching;
    return el;
  });
  byId["real-content"].hiddenFlag = !!options.realHidden;

  const fetchedFiles = [];
  const sandbox = {
    document: {
      createElement: () => fakeElement(),
      getElementById: (id) => byId[id],
      querySelector: (sel) => tbodies[sel],
      querySelectorAll: (sel) => (sel === "[data-selector]" ? boxes : []),
    },
    window: { getComputedStyle: (el) => ({ display: el.hiddenFlag ? "none" : "block" }) },
    fetch: async (url, opts) => {
      if (url in files) {
        fetchedFiles.push(url);
        return { ok: true, status: 200, json: async () => JSON.parse(files[url]) };
      }
      if (options.missingFiles) throw new Error("unexpected url " + url);
      const m = /^https:\/\/([^/]+)\/ads\/test\.js\?t=\d+$/.exec(url);
      assert.ok(m, "unexpected request: " + url);
      assert.strictEqual(opts.mode, "no-cors");
      requested.push(m[1]);
      const result = requestResult(m[1]);
      if (result === "loaded") return {};
      if (result === "hang") {
        return new Promise((resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      throw new TypeError("Failed to fetch");
    },
    AbortController,
    Date,
    // Timers are faked so nothing keeps node waiting. Timeout callbacks are kept
    // so a test can fire them by hand.
    setTimeout: (fn) => { sandbox.timeouts.push(fn); return sandbox.timeouts.length; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    timeouts: [],
    console,
  };
  if (options.missingFiles) {
    sandbox.fetch = async (url) => {
      if (url in files) return { ok: false, status: 404, json: async () => ({}) };
      throw new Error("unexpected url " + url);
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(TEST_JS, sandbox, { filename: "test-page/test.js" });
  return { sandbox, requested, byId, tbodies, boxes, fetchedFiles };
}

function serversInBaseRules() {
  return JSON.parse(BASE_RULES).map((rule) => /^\|\|(.+)\^$/.exec(rule.condition.urlFilter)[1]);
}

// ------------------------------------------------------------ network part

test("every server in base-rules.json is requested exactly once", async () => {
  const page = runPage();
  await settle();
  const expected = serversInBaseRules();
  assert.ok(expected.length >= 10);
  assert.deepStrictEqual(page.requested.slice().sort(), expected.slice().sort());
  assert.strictEqual(new Set(page.requested).size, page.requested.length);
});

test("one table row is added per server, with the server name in the first cell", async () => {
  const page = runPage();
  await settle();
  const rows = page.tbodies["#request-table tbody"].children;
  assert.strictEqual(rows.length, serversInBaseRules().length);
  assert.deepStrictEqual(rows.map((row) => row.children[0].textContent).sort(), serversInBaseRules().sort());
});

test("when every request fails the summary says all blocked and cells go green", async () => {
  const page = runPage();
  await settle();
  const total = serversInBaseRules().length;
  assert.strictEqual(page.byId["request-summary"].textContent, total + " of " + total + " blocked, 0 loaded, 0 no answer");
  for (const row of page.tbodies["#request-table tbody"].children) {
    assert.strictEqual(row.children[1].textContent, "blocked");
    assert.strictEqual(row.children[1].className, "blocked");
  }
});

test("when requests succeed the rows say loaded and use the red class", async () => {
  const page = runPage({ requestResult: () => "loaded" });
  await settle();
  const total = serversInBaseRules().length;
  assert.strictEqual(page.byId["request-summary"].textContent, "0 of " + total + " blocked, " + total + " loaded, 0 no answer");
  for (const row of page.tbodies["#request-table tbody"].children) {
    assert.strictEqual(row.children[1].textContent, "loaded");
    assert.strictEqual(row.children[1].className, "loaded");
  }
});

test("a mix of blocked and loaded is counted correctly", async () => {
  const servers = serversInBaseRules();
  const loaded = new Set(servers.slice(0, 3));
  const page = runPage({ requestResult: (s) => (loaded.has(s) ? "loaded" : "blocked") });
  await settle();
  assert.strictEqual(
    page.byId["request-summary"].textContent,
    (servers.length - 3) + " of " + servers.length + " blocked, 3 loaded, 0 no answer");
});

test("a request that never answers is shown as a timeout, not as blocked", async () => {
  const page = runPage({ requestResult: () => "hang" });
  await settle();
  const total = serversInBaseRules().length;
  assert.ok(page.byId["request-summary"].textContent.includes("still waiting for " + total));
  // Fire every timeout callback, as if 8 seconds had passed.
  for (const fn of page.sandbox.timeouts) fn();
  await settle();
  assert.strictEqual(page.byId["request-summary"].textContent, "0 of " + total + " blocked, 0 loaded, " + total + " no answer");
});

test("test.js has a request timeout constant", () => {
  assert.match(TEST_JS, /const REQUEST_TIMEOUT_MS = \d+;/);
});

test("rules without a ||host^ urlFilter are skipped, not requested", async () => {
  const rules = [
    { id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "||one.example^" } },
    { id: 2, priority: 1, action: { type: "block" }, condition: { requestDomains: ["two.example"] } },
    { id: 3, priority: 1, action: { type: "block" }, condition: { urlFilter: "||three.example/path" } },
    { id: 4, priority: 1, action: { type: "block" }, condition: { urlFilter: "||four.example^" } },
  ];
  const page = runPage({ files: { "../base-rules.json": JSON.stringify(rules) } });
  await settle();
  assert.deepStrictEqual(page.requested.sort(), ["four.example", "one.example"]);
});

test("if base-rules.json cannot be read the page says so and sends no requests", async () => {
  const page = runPage({ missingFiles: true });
  await settle();
  assert.deepStrictEqual(page.requested, []);
  assert.ok(page.byId["request-summary"].textContent.includes("Could not read base-rules.json"));
  assert.ok(page.byId["request-summary"].textContent.includes("http.server"));
});

test("test.js reads ../base-rules.json and ../base-hide.json through fetch", async () => {
  const page = runPage();
  await settle();
  assert.ok(page.fetchedFiles.includes("../base-rules.json"));
  assert.ok(page.fetchedFiles.includes("../base-hide.json"));
});

// ------------------------------------------------------------ hiding part

test("hidden fake ads are counted and shown as good, visible ones as bad", async () => {
  const page = runPage({
    boxes: [
      { selector: ".a", hidden: true },
      { selector: ".b", hidden: false },
      { selector: ".c", hidden: true },
    ],
  });
  await settle();
  const rows = page.tbodies["#hide-table tbody"].children;
  assert.strictEqual(rows.length, 4); // three boxes plus the real content row
  assert.deepStrictEqual(rows.slice(0, 3).map((r) => r.children[1].className), ["good", "bad", "good"]);
  assert.strictEqual(
    page.byId["hide-summary"].textContent,
    "2 of 3 fake ads hidden. Real content is still showing.");
});

test("the real content box visible is good, hidden is reported as wrong", async () => {
  const ok = runPage({ boxes: [{ selector: ".a", hidden: true }] });
  await settle();
  const okLast = ok.tbodies["#hide-table tbody"].children.slice(-1)[0];
  assert.strictEqual(okLast.children[1].textContent, "visible (correct)");
  assert.strictEqual(okLast.children[1].className, "good");

  const bad = runPage({ boxes: [{ selector: ".a", hidden: true }], realHidden: true });
  await settle();
  const badLast = bad.tbodies["#hide-table tbody"].children.slice(-1)[0];
  assert.strictEqual(badLast.children[1].textContent, "hidden (wrong)");
  assert.strictEqual(badLast.children[1].className, "bad");
  assert.ok(bad.byId["hide-summary"].textContent.includes("HIDDEN, which is wrong"));
});

test("the check-again button is wired to the hiding check", async () => {
  const page = runPage({ boxes: [{ selector: ".a", hidden: false }] });
  await settle();
  assert.strictEqual(typeof page.byId["recheck-button"].listeners.click, "function");
  page.boxes[0].hiddenFlag = true;
  page.byId["recheck-button"].listeners.click();
  assert.strictEqual(page.byId["hide-summary"].textContent, "1 of 1 fake ads hidden. Real content is still showing.");
});

// ------------------------------------------------------------ page coverage warnings

test("coverage check: a box that does not match its own selector is reported", async () => {
  const page = runPage({ boxes: [{ selector: ".a", hidden: true, notMatching: true }] });
  await settle();
  assert.ok(page.byId["hide-warnings"].textContent.includes("does not match its own selector: .a"));
});

test("coverage check: selectors in base-hide.json without a box are listed", async () => {
  const hide = JSON.parse(BASE_HIDE);
  const page = runPage({ boxes: [{ selector: hide.generic[0], hidden: true }] });
  await settle();
  const text = page.byId["hide-warnings"].textContent;
  assert.ok(text.includes("No test box yet for:"));
  assert.ok(!text.includes(hide.generic[0] + ","), "the covered selector must not be listed");
  assert.ok(text.includes(hide.generic[1]));
});

test("coverage check: with a box for every selector there is no warning", async () => {
  const hide = JSON.parse(BASE_HIDE);
  const page = runPage({ boxes: hide.generic.map((selector) => ({ selector, hidden: true })) });
  await settle();
  assert.strictEqual(page.byId["hide-warnings"].textContent, "");
});
