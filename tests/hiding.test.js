// tests/hiding.test.js
//
// Extra tests for the hiding feature (background.js hide handler and content.js),
// run without Chrome. Both scripts are loaded into a node "vm" sandbox with a
// fake chrome object. Tests that use the real converted list (rules/hide.json)
// are skipped when that file is missing, as it is in a fresh clone.
// Run:  node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const BACKGROUND_SOURCE = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const CONTENT_SOURCE = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
const SITES_SOURCE = fs.readFileSync(path.join(ROOT, "lib", "sites.js"), "utf8");
const BASE_HIDE_TEXT = fs.readFileSync(path.join(ROOT, "base-hide.json"), "utf8");
const REAL_HIDE_PATH = path.join(ROOT, "rules", "hide.json");
const HAVE_REAL_HIDE = fs.existsSync(REAL_HIDE_PATH);

const HIDE = "{display:none!important}";

// Limits for the real-data timing test (generous, so a slow machine does not fail).
const MAX_FIRST_BUILD_MS = 3000;
const MAX_CACHED_BUILD_MS = 100;

async function settle() {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

// Loads background.js into a sandbox with a fake chrome.
//   options.files:       map of extension path -> JSON text (a missing key means a missing file)
//   options.storage:     starting content of chrome.storage.local
//   options.insertMode:  "ok" (default), "reject", "throw"
//   options.storageFails make storage.local.get reject
function loadBackground(options) {
  options = options || {};
  const files = options.files || {};
  const storage = Object.assign({}, options.storage || {});
  const inserted = [];
  const fetched = [];
  const listeners = { message: [] };
  const warnings = [];

  const chrome = {
    declarativeNetRequest: {
      async setExtensionActionOptions() {},
      async getDynamicRules() { return []; },
      async updateDynamicRules() {},
    },
    runtime: {
      getURL: (p) => "chrome-extension://fakeid/" + p,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
    scripting: {
      insertCSS(details) {
        if (options.insertMode === "throw") throw new Error("sync failure");
        if (options.insertMode === "reject") return Promise.reject(new Error("No tab with id"));
        inserted.push(JSON.parse(JSON.stringify(details)));
        return Promise.resolve();
      },
    },
    storage: {
      local: {
        async get(key) {
          if (options.storageFails) throw new Error("storage down");
          const out = {};
          if (key in storage) out[key] = JSON.parse(JSON.stringify(storage[key]));
          return out;
        },
      },
      onChanged: { addListener() {} },
    },
  };

  const sandbox = {
    chrome,
    fetch: async (url) => {
      const p = String(url).replace("chrome-extension://fakeid/", "");
      fetched.push(p);
      if (!(p in files)) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, async json() { return JSON.parse(files[p]); } };
    },
    console: { log() {}, warn: (...a) => warnings.push(a.join(" ")), error() {} },
    URL,
  };
  vm.createContext(sandbox);
  sandbox.importScripts = () => vm.runInContext(SITES_SOURCE, sandbox, { filename: "lib/sites.js" });
  vm.runInContext(BACKGROUND_SOURCE, sandbox, { filename: "background.js" });

  return {
    sandbox, inserted, fetched, listeners, storage, warnings,
    // Sends a message to every listener, waits, returns what the first listener returned.
    send: async (message, sender) => {
      let returned;
      for (const fn of listeners.message) returned = fn(message, sender);
      await settle();
      return returned;
    },
    // Calls the CSS builder directly (used for timing).
    cssFor: (hostname) => vm.runInContext("getCssForHostname", sandbox)(hostname),
    constant: (expression) => vm.runInContext(expression, sandbox),
  };
}

function topSender(url, tabId) {
  return { tab: { id: tabId || 1, url }, frameId: 0, url };
}

function frameSender(topUrl, frameUrl, frameId) {
  return { tab: { id: 1, url: topUrl }, frameId: frameId || 4, url: frameUrl };
}

// Splits CSS back into selectors, requiring exactly "selector{display:none!important}" per line.
function parseLines(css) {
  return css.split("\n").map((line) => {
    assert.ok(line.endsWith(HIDE), "line does not end with the hide block: " + line.slice(0, 80));
    const selector = line.slice(0, line.length - HIDE.length);
    assert.ok(selector.length > 0, "empty selector");
    assert.ok(!/[{}\n\r]/.test(selector), "extra brace or line break in: " + line.slice(0, 80));
    return selector;
  });
}

// A small model of how a browser splits a stylesheet into rules (CSS Syntax rules):
// strings, escapes, comments and nested [] () {} blocks. It counts the top-level
// { } blocks that close properly. If a selector has an unclosed [ or ( it swallows
// the rules after it, and the count drops below the number of lines.
function countTopLevelBlocks(css) {
  const stack = [];
  const closers = { "]": "[", ")": "(", "}": "{" };
  let blocks = 0;
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      // A string ends at its quote, or (as a bad string) just before a line break.
      while (i < css.length && css[i] !== c && css[i] !== "\n") {
        if (css[i] === "\\") i++;
        i++;
      }
      if (css[i] === c) i++;
      continue;
    }
    if (c === "[" || c === "(" || c === "{") {
      stack.push(c);
    } else if (closers[c] && stack.length > 0 && stack[stack.length - 1] === closers[c]) {
      stack.pop();
      if (c === "}" && stack.length === 0) blocks++;
    }
    i++;
  }
  return blocks;
}

// Independent version of "hostname and each parent domain, stopping before the bare TLD".
function parentsOf(host) {
  const parts = host.split(".");
  if (parts.length < 2) return [host];
  const out = [];
  for (let i = 0; i <= parts.length - 2; i++) out.push(parts.slice(i).join("."));
  return out;
}

// What the CSS for a host should be, worked out separately from background.js.
function expectedSelectors(base, hide, host) {
  const unique = (list) => Array.from(new Set(list));
  const generic = unique([].concat(base.generic || [], hide.generic || []));
  const gather = (table) => {
    let all = [];
    for (const domain of parentsOf(host)) {
      if (Object.prototype.hasOwnProperty.call(table || {}, domain)) all = all.concat(table[domain]);
    }
    return all;
  };
  const exceptions = new Set(gather(hide.siteExceptions));
  const sites = unique(gather(hide.sites)).filter((s) => !exceptions.has(s));
  return generic.filter((s) => !exceptions.has(s)).concat(sites);
}

// Runs fn and returns the unhandled promise rejections seen while it ran.
async function captureUnhandled(fn) {
  const seen = [];
  const handler = (reason) => seen.push(reason);
  process.on("unhandledRejection", handler);
  try {
    await fn();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", handler);
  }
  return seen;
}

const FILES = {
  "base-hide.json": JSON.stringify({ generic: [".base-ad", "[id^=\"promo-\"]"] }),
  "rules/hide.json": JSON.stringify({
    generic: [".gen-a", ".gen-b", ".gen-c"],
    sites: {
      "example.com": [".ex-only", ".gen-b"],
      "b.example.com": [".b-only"],
    },
    siteExceptions: {
      "example.com": [".gen-a"],
      "quiet.org": [".base-ad", ".gen-c"],
    },
  }),
};

// ------------------------------------------------------------ CSS shape

test("every line is exactly selector + the hide block, one selector per line", async () => {
  const bg = loadBackground({ files: FILES });
  await bg.send({ type: "hide" }, topSender("https://plain.net/"));
  const css = bg.inserted[0].css;
  const lines = css.split("\n");
  assert.strictEqual(lines.length, 5);
  for (const line of lines) {
    assert.strictEqual(line.split("{").length, 2, "one { per line: " + line);
    assert.strictEqual(line.split("}").length, 2, "one } per line: " + line);
    assert.ok(line.endsWith(HIDE));
  }
  assert.deepStrictEqual(parseLines(css), [".base-ad", '[id^="promo-"]', ".gen-a", ".gen-b", ".gen-c"]);
  assert.ok(!css.endsWith("\n") && !css.startsWith("\n"));
});

test("the stylesheet model sees one rule per line for good selectors", () => {
  const css = [".a", "div[x=\"y\"]", "a:not(.b)", "p:has(> img[src$=\"]\"])"].map((s) => s + HIDE).join("\n");
  assert.strictEqual(countTopLevelBlocks(css), 4);
});

test("the stylesheet model notices an unclosed bracket swallowing later rules", () => {
  const css = [".a", "div[bad", ".b", "i[src=\"z\"]"].map((s) => s + HIDE).join("\n");
  assert.ok(countTopLevelBlocks(css) < 4);
});

// A selector with an unclosed [ or ( (or an unterminated quote) would swallow the
// rules after it in the browser, so cleanSelectors in background.js drops them.
test("an unbalanced selector must not swallow the rules after it", async () => {
  const files = {
    "rules/hide.json": JSON.stringify({ generic: [".a", "div[bad", ".b", "p(x", ".c", ".q\"x", ".d", ".e"] }),
  };
  const bg = loadBackground({ files });
  await bg.send({ type: "hide" }, topSender("https://plain.net/"));
  const css = bg.inserted[0].css;
  assert.strictEqual(countTopLevelBlocks(css), css.split("\n").length);
});

test("selectors with strings, escapes and nested brackets are kept and stay balanced", async () => {
  const good = [
    "a[href*=\"x{y\"]", // a brace inside a string is dropped by the worker (see below)
    "a[onclick^=\"w('https://x/')\"]",
    "article[data-ft*=\"\\\"ei\\\"\"]",
    "div:not(.a):has(> img[alt=\"]\"])",
  ];
  const bg = loadBackground({ files: { "rules/hide.json": JSON.stringify({ generic: good }) } });
  await bg.send({ type: "hide" }, topSender("https://plain.net/"));
  const lines = parseLines(bg.inserted[0].css);
  // The one holding "{" is dropped on purpose, the other three stay.
  assert.deepStrictEqual(lines, good.slice(1));
  assert.strictEqual(countTopLevelBlocks(bg.inserted[0].css), 3);
});

test("selectors are trimmed and duplicates across base, generic and the site list are removed", async () => {
  const files = {
    "base-hide.json": JSON.stringify({ generic: ["  .x  ", ".y"] }),
    "rules/hide.json": JSON.stringify({ generic: [".x", ".y", ".z"], sites: { "a.com": [".z", ".w", ".w"] } }),
  };
  const bg = loadBackground({ files });
  await bg.send({ type: "hide" }, topSender("https://a.com/"));
  // The site list may repeat a generic selector (the browser ignores the repeat), but not itself.
  const lines = parseLines(bg.inserted[0].css);
  assert.deepStrictEqual(lines.slice(0, 3), [".x", ".y", ".z"]);
  assert.strictEqual(lines.filter((s) => s === ".w").length, 1);
});

// ------------------------------------------------------------ exceptions and site matching

test("an exception removes the selector for that host and its subdomains only", async () => {
  const bg = loadBackground({ files: FILES });
  for (const url of [
    "https://example.com/", "https://www.example.com/", "https://a.b.example.com/", "https://x.example.com/",
    "https://notexample.com/", "https://example.com.evil.org/", "https://other.net/",
  ]) {
    await bg.send({ type: "hide" }, topSender(url));
  }
  const has = (i, sel) => parseLines(bg.inserted[i].css).includes(sel);
  for (const i of [0, 1, 2, 3]) assert.ok(!has(i, ".gen-a"), "exception should apply: " + i);
  for (const i of [4, 5, 6]) assert.ok(has(i, ".gen-a"), "exception must not apply: " + i);
});

test("an exception on a subdomain does not apply to the parent domain", async () => {
  const files = {
    "rules/hide.json": JSON.stringify({ generic: [".g1", ".g2"], siteExceptions: { "sub.site.com": [".g1"] } }),
  };
  const bg = loadBackground({ files });
  await bg.send({ type: "hide" }, topSender("https://sub.site.com/"));
  await bg.send({ type: "hide" }, topSender("https://deep.sub.site.com/"));
  await bg.send({ type: "hide" }, topSender("https://site.com/"));
  await bg.send({ type: "hide" }, topSender("https://other.site.com/"));
  assert.deepStrictEqual(parseLines(bg.inserted[0].css), [".g2"]);
  assert.deepStrictEqual(parseLines(bg.inserted[1].css), [".g2"]);
  assert.deepStrictEqual(parseLines(bg.inserted[2].css), [".g1", ".g2"]);
  assert.deepStrictEqual(parseLines(bg.inserted[3].css), [".g1", ".g2"]);
});

test("an exception also removes that selector from the built-in list and from the site's own list", async () => {
  const bg = loadBackground({ files: FILES });
  await bg.send({ type: "hide" }, topSender("https://quiet.org/"));
  const lines = parseLines(bg.inserted[0].css);
  assert.ok(!lines.includes(".base-ad") && !lines.includes(".gen-c"));
  assert.ok(lines.includes(".gen-a") && lines.includes(".gen-b"));
});

test("site selectors for example.com reach www, deep subdomains and nothing else", async () => {
  const bg = loadBackground({ files: FILES });
  const hosts = ["example.com", "www.example.com", "a.b.example.com", "notexample.com", "example.com.evil.org", "com", "localhost", "127.0.0.1"];
  for (const host of hosts) await bg.send({ type: "hide" }, topSender("http://" + host + "/"));
  const exOnly = (i) => parseLines(bg.inserted[i].css).includes(".ex-only");
  assert.ok(exOnly(0) && exOnly(1) && exOnly(2));
  for (let i = 3; i < hosts.length; i++) assert.ok(!exOnly(i), "must not apply to " + hosts[i]);
  // b.example.com own selectors reach a.b.example.com but not example.com
  const bOnly = (i) => parseLines(bg.inserted[i].css).includes(".b-only");
  assert.ok(!bOnly(0) && !bOnly(1) && bOnly(2));
});

test("a port, a path, a query and capital letters in the address do not change the host", async () => {
  const bg = loadBackground({ files: FILES });
  await bg.send({ type: "hide" }, topSender("https://WWW.Example.COM:8443/a/b?q=1#top"));
  assert.ok(parseLines(bg.inserted[0].css).includes(".ex-only"));
});

test("two hosts in a row do not share filtered CSS by mistake", async () => {
  const bg = loadBackground({ files: FILES });
  await bg.send({ type: "hide" }, topSender("https://quiet.org/"));
  await bg.send({ type: "hide" }, topSender("https://loud.org/"));
  await bg.send({ type: "hide" }, topSender("https://quiet.org/again"));
  assert.ok(!parseLines(bg.inserted[0].css).includes(".gen-c"));
  assert.ok(parseLines(bg.inserted[1].css).includes(".gen-c"));
  assert.strictEqual(bg.inserted[0].css, bg.inserted[2].css);
});

// ------------------------------------------------------------ allowlist

test("allowlist: the site, www, deep subdomains get nothing; look-alike names still get CSS", async () => {
  const bg = loadBackground({ files: FILES, storage: { allowlist: ["example.com"] } });
  await bg.send({ type: "hide" }, topSender("https://example.com/"));
  await bg.send({ type: "hide" }, topSender("https://www.example.com/"));
  await bg.send({ type: "hide" }, topSender("https://a.b.example.com/"));
  assert.strictEqual(bg.inserted.length, 0);
  await bg.send({ type: "hide" }, topSender("https://notexample.com/"));
  await bg.send({ type: "hide" }, topSender("https://example.com.evil.org/"));
  assert.strictEqual(bg.inserted.length, 2);
});

test("allowlist entries are matched case-insensitively and with a leading www", async () => {
  const bg = loadBackground({ files: FILES, storage: { allowlist: ["WWW.Example.com"] } });
  await bg.send({ type: "hide" }, topSender("https://example.com/"));
  await bg.send({ type: "hide" }, topSender("https://sub.example.com/"));
  assert.strictEqual(bg.inserted.length, 0);
});

test("allowlist: every frame of an allowlisted page gets nothing, whatever its own domain", async () => {
  const bg = loadBackground({ files: FILES, storage: { allowlist: ["news.org"] } });
  const top = "https://www.news.org/story";
  await bg.send({ type: "hide" }, frameSender(top, "https://ads.adserver.net/f", 2));
  await bg.send({ type: "hide" }, frameSender(top, "https://example.com/f", 3));
  await bg.send({ type: "hide" }, frameSender(top, "https://news.org/f", 4));
  await bg.send({ type: "hide" }, frameSender(top, "about:blank", 5));
  await bg.send({ type: "hide" }, frameSender(top, "data:text/html,hi", 6));
  assert.strictEqual(bg.inserted.length, 0);
});

test("allowlist: the top page decides, so a frame from an allowlisted domain still gets CSS", async () => {
  const bg = loadBackground({ files: FILES, storage: { allowlist: ["example.com"] } });
  await bg.send({ type: "hide" }, frameSender("https://other.net/", "https://www.example.com/embed", 7));
  assert.strictEqual(bg.inserted.length, 1);
  assert.deepStrictEqual(bg.inserted[0].target, { tabId: 1, frameIds: [7] });
});

test("pages that are not on the web get nothing, in the top page or in a frame", async () => {
  const bg = loadBackground({ files: FILES });
  const tops = ["chrome://settings/", "chrome-extension://abc/page.html", "file:///tmp/a.html", "about:blank", "devtools://devtools/x", "ftp://example.com/", "view-source:https://example.com/", "", "not a url"];
  for (const url of tops) {
    await bg.send({ type: "hide" }, topSender(url));
    await bg.send({ type: "hide" }, frameSender(url, "https://example.com/f", 3));
  }
  assert.strictEqual(bg.inserted.length, 0);
});

test("a blank or data frame inside a normal page gets CSS using the page's host", async () => {
  const bg = loadBackground({ files: FILES });
  await bg.send({ type: "hide" }, frameSender("https://www.example.com/", "about:blank", 8));
  await bg.send({ type: "hide" }, frameSender("https://www.example.com/", "data:text/html,hi", 9));
  assert.strictEqual(bg.inserted.length, 2);
  for (const call of bg.inserted) assert.ok(parseLines(call.css).includes(".ex-only"));
});

test("missing tab id or a tab id that is not a number gets nothing", async () => {
  const bg = loadBackground({ files: FILES });
  await bg.send({ type: "hide" }, { tab: { url: "https://a.com/" }, frameId: 0, url: "https://a.com/" });
  await bg.send({ type: "hide" }, { tab: { id: "3", url: "https://a.com/" }, frameId: 0, url: "https://a.com/" });
  assert.strictEqual(bg.inserted.length, 0);
});

test("a missing frame id is treated as the top frame", async () => {
  const bg = loadBackground({ files: FILES });
  await bg.send({ type: "hide" }, { tab: { id: 2, url: "https://a.com/" }, url: "https://a.com/" });
  assert.deepStrictEqual(bg.inserted[0].target, { tabId: 2, frameIds: [0] });
});

// ------------------------------------------------------------ robustness

test("a missing rules/hide.json still hides with the built-in list", async () => {
  const bg = loadBackground({ files: { "base-hide.json": FILES["base-hide.json"] } });
  await bg.send({ type: "hide" }, topSender("https://a.com/"));
  assert.deepStrictEqual(parseLines(bg.inserted[0].css), [".base-ad", '[id^="promo-"]']);
});

test("a hide file with the wrong shape is treated as empty, not as an error", async () => {
  const shapes = ["[]", "5", "null", '"text"', '{"generic": "x", "sites": [], "siteExceptions": 3}', '{"generic": [null, 4, ".ok"], "sites": {"a.com": "nope"}}'];
  for (const shape of shapes) {
    const bg = loadBackground({ files: { "base-hide.json": FILES["base-hide.json"], "rules/hide.json": shape } });
    const seen = await captureUnhandled(() => bg.send({ type: "hide" }, topSender("https://a.com/")));
    assert.deepStrictEqual(seen, [], shape);
    assert.strictEqual(bg.inserted.length, 1, shape);
    assert.ok(parseLines(bg.inserted[0].css).includes(".base-ad"), shape);
  }
});

test("insertCSS rejecting (closed tab) leaves no unhandled rejection and no warning", async () => {
  const bg = loadBackground({ files: FILES, insertMode: "reject" });
  const seen = await captureUnhandled(async () => {
    await bg.send({ type: "hide" }, topSender("https://a.com/"));
    await bg.send({ type: "hide" }, frameSender("https://a.com/", "https://b.com/", 3));
  });
  assert.deepStrictEqual(seen, []);
  assert.deepStrictEqual(bg.warnings, []);
});

test("insertCSS throwing at once leaves no unhandled rejection", async () => {
  const bg = loadBackground({ files: FILES, insertMode: "throw" });
  const seen = await captureUnhandled(() => bg.send({ type: "hide" }, topSender("https://a.com/")));
  assert.deepStrictEqual(seen, []);
});

test("storage failing leaves no unhandled rejection and nothing is injected", async () => {
  const bg = loadBackground({ files: FILES, storageFails: true });
  const seen = await captureUnhandled(() => bg.send({ type: "hide" }, topSender("https://a.com/")));
  assert.deepStrictEqual(seen, []);
  assert.strictEqual(bg.inserted.length, 0);
});

test("the hide files are fetched once even when many messages arrive at the same time", async () => {
  const bg = loadBackground({ files: FILES });
  for (let i = 0; i < 30; i++) {
    const host = i % 3 === 0 ? "example.com" : "site" + i + ".org";
    for (const fn of bg.listeners.message) fn({ type: "hide" }, topSender("https://" + host + "/", i + 1));
  }
  await settle();
  assert.strictEqual(bg.inserted.length, 30);
  assert.deepStrictEqual(bg.fetched.slice().sort(), ["base-hide.json", "rules/hide.json"]);
});

test("with both files missing they are still tried only once", async () => {
  const bg = loadBackground({ files: {} });
  for (let i = 0; i < 6; i++) await bg.send({ type: "hide" }, topSender("https://a" + i + ".com/"));
  assert.strictEqual(bg.fetched.length, 2);
  assert.strictEqual(bg.inserted.length, 0);
});

test("other message types are ignored and the listener never returns true", async () => {
  const bg = loadBackground({ files: FILES });
  const messages = [{ type: "hide" }, { type: "other" }, {}, null, undefined, "hide", 5, { type: "HIDE" }, { type: "getStatus", tabId: 1 }];
  for (const message of messages) {
    const returned = await bg.send(message, topSender("https://a.com/"));
    assert.notStrictEqual(returned, true, JSON.stringify(message));
    assert.ok(returned === undefined || returned === false, "no promise or value is returned");
  }
  assert.strictEqual(bg.inserted.length, 1); // only the first, valid message
});

test("hide: messages from other tabs each get their own tab id", async () => {
  const bg = loadBackground({ files: FILES });
  await bg.send({ type: "hide" }, topSender("https://a.com/", 11));
  await bg.send({ type: "hide" }, topSender("https://a.com/", 12));
  assert.deepStrictEqual(bg.inserted.map((c) => c.target.tabId), [11, 12]);
});

// ------------------------------------------------------------ content.js

// Runs content.js with a fake chrome and records everything it touches.
function runContent(makeChrome) {
  const touched = [];
  const sent = [];
  const sandbox = {};
  // Page things the script has no reason to use. Touching one is recorded.
  for (const name of ["document", "window", "location", "navigator", "localStorage", "sessionStorage",
    "XMLHttpRequest", "fetch", "WebSocket", "Image", "MutationObserver", "addEventListener", "postMessage", "eval"]) {
    Object.defineProperty(sandbox, name, { get() { touched.push(name); return undefined; }, configurable: true });
  }
  const chromeObject = makeChrome(sent, touched);
  if (chromeObject !== "absent") sandbox.chrome = chromeObject;
  vm.createContext(sandbox);
  let thrown = null;
  try {
    vm.runInContext(CONTENT_SOURCE, sandbox, { filename: "content.js" });
  } catch (e) {
    thrown = e;
  }
  return { sent, touched, thrown };
}

// A fake chrome object where any property other than runtime.sendMessage is recorded.
function recordingChrome(sendImpl) {
  return (sent, touched) => new Proxy({}, {
    get(_, key) {
      if (key !== "runtime") { touched.push("chrome." + String(key)); return undefined; }
      return new Proxy({}, {
        get(__, inner) {
          if (inner !== "sendMessage") { touched.push("chrome.runtime." + String(inner)); return undefined; }
          return (...args) => { sent.push(JSON.parse(JSON.stringify(args))); return sendImpl(); };
        },
      });
    },
  });
}

test("content.js sends exactly one message {type:'hide'} and touches nothing else", () => {
  const run = runContent(recordingChrome(() => Promise.resolve()));
  assert.strictEqual(run.thrown, null);
  assert.deepStrictEqual(run.sent, [[{ type: "hide" }]]);
  assert.deepStrictEqual(run.touched, []);
});

test("content.js source: no page access and nothing but the one sendMessage call", () => {
  // Remove comments first, so the explanation in them is not checked.
  const code = CONTENT_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const word of ["document", "window", "location", "navigator", "innerHTML", "cookie", "localStorage",
    "XMLHttpRequest", "fetch", "WebSocket", "eval", "Function(", "querySelector", "getElement",
    "addEventListener", "postMessage", "storage", "href", "textContent", "innerText"]) {
    assert.ok(!code.includes(word), "content.js must not use " + word);
  }
  assert.strictEqual((code.match(/chrome\./g) || []).length, 1);
  assert.strictEqual((code.match(/sendMessage\(/g) || []).length, 1);
  assert.ok(code.includes('sendMessage({ type: "hide" })'));
});

test("content.js swallows a thrown error from sendMessage", () => {
  const run = runContent(recordingChrome(() => { throw new Error("Extension context invalidated."); }));
  assert.strictEqual(run.thrown, null);
});

test("content.js swallows a rejected promise from sendMessage", async () => {
  const seen = await captureUnhandled(async () => {
    const run = runContent(recordingChrome(() => Promise.reject(new Error("Receiving end does not exist"))));
    assert.strictEqual(run.thrown, null);
  });
  assert.deepStrictEqual(seen, []);
});

test("content.js copes with sendMessage returning nothing or something that is not a promise", () => {
  for (const value of [undefined, null, 5, {}, { catch: 1 }, { then() {} }]) {
    const run = runContent(recordingChrome(() => value));
    assert.strictEqual(run.thrown, null, String(value));
    assert.strictEqual(run.sent.length, 1);
  }
});

test("content.js copes with a missing chrome object or a missing runtime", () => {
  assert.strictEqual(runContent(() => "absent").thrown, null);
  assert.strictEqual(runContent(() => ({})).thrown, null);
  assert.strictEqual(runContent(() => ({ runtime: undefined })).thrown, null);
  assert.strictEqual(runContent(() => ({ runtime: {} })).thrown, null);
});

// ------------------------------------------------------------ real converted list

const realTest = { skip: HAVE_REAL_HIDE ? false : "rules/hide.json is not present (run tools/convert.py to make it)" };

function loadWithRealData() {
  return {
    bg: loadBackground({
      files: { "base-hide.json": BASE_HIDE_TEXT, "rules/hide.json": fs.readFileSync(REAL_HIDE_PATH, "utf8") },
    }),
    base: JSON.parse(BASE_HIDE_TEXT),
    hide: JSON.parse(fs.readFileSync(REAL_HIDE_PATH, "utf8")),
  };
}

test("real list: generic CSS is one clean rule per line, matches the list, and parses as that many rules", realTest, async (t) => {
  const { bg, base, hide } = loadWithRealData();

  let started = process.hrtime.bigint();
  const first = await bg.cssFor("plain-host-without-rules.example");
  const firstMs = Number(process.hrtime.bigint() - started) / 1e6;

  started = process.hrtime.bigint();
  const again = await bg.cssFor("another-host.example");
  const againMs = Number(process.hrtime.bigint() - started) / 1e6;

  const lines = parseLines(first);
  const expected = expectedSelectors(base, hide, "plain-host-without-rules.example");
  const rawCount = new Set([].concat(base.generic, hide.generic)).size;
  const dropped = rawCount - expected.length;

  t.diagnostic("generic selectors in rules/hide.json: " + hide.generic.length);
  t.diagnostic("lines in the built CSS: " + lines.length);
  t.diagnostic("CSS size: " + first.length + " characters (" + (Buffer.byteLength(first) / 1024).toFixed(0) + " KB)");
  t.diagnostic("first build (read two files, clean, join): " + firstMs.toFixed(1) + " ms");
  t.diagnostic("later page, same CSS reused: " + againMs.toFixed(2) + " ms");
  t.diagnostic("generic selectors dropped by the worker as unsafe: " + dropped);

  assert.ok(lines.length > 10000, "expected more than 10000 generic selectors");
  assert.strictEqual(lines.length, new Set(lines).size, "no duplicate lines");
  assert.strictEqual(lines.join("\n"), expected.join("\n"));
  assert.strictEqual(again, first);
  assert.strictEqual(countTopLevelBlocks(first), lines.length, "a selector swallows the rules after it");
  assert.ok(firstMs < MAX_FIRST_BUILD_MS, "first build took " + firstMs + " ms");
  assert.ok(againMs < MAX_CACHED_BUILD_MS, "cached build took " + againMs + " ms");
});

test("real list: no selector in the file is dropped as unsafe, none is empty or untrimmed", realTest, () => {
  const { hide } = loadWithRealData();
  const every = [].concat(hide.generic);
  for (const table of [hide.sites, hide.siteExceptions]) {
    for (const key of Object.keys(table)) every.push(...table[key]);
  }
  const unsafe = every.filter((s) => typeof s !== "string" || s.trim() === "" || s !== s.trim() || /[{}\n\r]/.test(s));
  assert.deepStrictEqual(unsafe.slice(0, 5), []);
});

test("real list: site and exception hosts give the exact expected CSS, and every page parses as whole rules", realTest, async (t) => {
  const { bg, base, hide } = loadWithRealData();
  const bySize = Object.keys(hide.sites).sort((a, b) => hide.sites[b].length - hide.sites[a].length);
  const exceptionHosts = Object.keys(hide.siteExceptions).slice(0, 25);
  const hosts = [];
  for (const host of bySize.slice(0, 15).concat(exceptionHosts)) {
    hosts.push(host, "www." + host, "deep.sub." + host);
  }
  hosts.push("notexample.invalid", "localhost", "127.0.0.1");

  let slowest = 0;
  for (const host of hosts) {
    const started = process.hrtime.bigint();
    const css = await bg.cssFor(host);
    slowest = Math.max(slowest, Number(process.hrtime.bigint() - started) / 1e6);
    const lines = parseLines(css);
    const expected = expectedSelectors(base, hide, host);
    assert.strictEqual(lines.length, expected.length, host);
    assert.strictEqual(lines.join("\n"), expected.join("\n"), host);
    assert.strictEqual(countTopLevelBlocks(css), lines.length, "swallowed rule for " + host);
  }
  t.diagnostic("hosts checked: " + hosts.length + ", slowest build: " + slowest.toFixed(1) + " ms");
});

test("real list: an exception host loses its selectors and a different host keeps them", realTest, async () => {
  const { bg, hide } = loadWithRealData();
  const exceptionHost = Object.keys(hide.siteExceptions).find((host) => {
    return hide.siteExceptions[host].some((s) => hide.generic.includes(s));
  });
  assert.ok(exceptionHost, "no exception for a generic selector found in the real list");
  const target = hide.siteExceptions[exceptionHost].find((s) => hide.generic.includes(s));
  const withException = parseLines(await bg.cssFor(exceptionHost));
  const subdomain = parseLines(await bg.cssFor("shop." + exceptionHost));
  const elsewhere = parseLines(await bg.cssFor("unrelated-" + exceptionHost));
  assert.ok(!withException.includes(target));
  assert.ok(!subdomain.includes(target));
  assert.ok(elsewhere.includes(target));
});

test("real list: building for every exception host keeps the cache at its limit and stays fast", realTest, async (t) => {
  const { bg, hide } = loadWithRealData();
  const hosts = Object.keys(hide.siteExceptions);
  const max = bg.constant("MAX_CSS_CACHE");
  const started = process.hrtime.bigint();
  for (const host of hosts) await bg.cssFor(host);
  const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
  t.diagnostic(hosts.length + " exception hosts built in " + totalMs.toFixed(0) + " ms (" + (totalMs / hosts.length).toFixed(2) + " ms each)");
  assert.ok(bg.constant("filteredCssCache.size") <= max);
});

test("real list: a full message round trip inserts the CSS once for the right tab and frame", realTest, async () => {
  const { bg } = loadWithRealData();
  await bg.send({ type: "hide" }, frameSender("https://www.example.org/", "https://ads.example.net/x", 9));
  assert.strictEqual(bg.inserted.length, 1);
  assert.deepStrictEqual(bg.inserted[0].target, { tabId: 1, frameIds: [9] });
  assert.strictEqual(bg.inserted[0].origin, "USER");
  assert.ok(bg.inserted[0].css.length > 100000);
});
