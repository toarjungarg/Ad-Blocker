// background.js
//
// The service worker: the extension's background script. Chrome starts it when
// it is needed and stops it when it is idle, so it must not keep state in
// variables that it cannot rebuild.
//
// What it does:
//   1. Turns on the blocked-count number on the toolbar icon.
//   2. Loads the converted EasyList rules from rules/network.json (if that file
//      exists) as dynamic rules, in chunks. Without the file, only the small
//      built-in list (base-rules.json) is used.
//   3. Keeps one extra "allowlist" rule up to date, so sites the user turned
//      blocking off for are left alone.
//   4. Hides ad boxes that are still on the page after the network rules did
//      their work. content.js sends a "hide" message when a page (or a frame
//      inside it) starts loading. This file answers by injecting a stylesheet
//      with "display:none" rules into that page, unless the site is on the
//      allowlist. The selectors come from rules/hide.json (made by
//      tools/convert.py) plus the small built-in list in base-hide.json.
//   5. Keeps a list of what was blocked on each tab, for the popup's dropdown
//      (see "blocked list" below).
//
// Why dynamic rules for the converted lists? A rule file named in manifest.json
// must exist or Chrome will not load the extension, and rules/ is not in the
// repo. Dynamic rules are added by code, so a missing file is not a problem.

// ---------------------------------------------------------------- constants

// The one dynamic rule that holds the user's allowlist. Converted rules use ids
// 1 to N, so this id is far above them and can never clash.
const ALLOWLIST_RULE_ID = 1000000;

// Allowlist priority. Higher priority wins, so this beats every block rule
// (block is 1, exceptions 2, important blocks 3).
const ALLOWLIST_PRIORITY = 100;

// How many rules are sent to Chrome in one call. Smaller chunks mean a bad rule
// only spoils a small group, and a failed chunk is quick to retry one by one.
const RULE_CHUNK_SIZE = 5000;

// The most converted rules we will load. Chrome allows 30,000 dynamic rules and
// one of them is the allowlist rule. tools/convert.py has the same number
// (MAX_NETWORK_RULES), so change both together.
const MAX_CONVERTED_RULES = 29900;

// How many "bad rule skipped" warnings to print. After this we only print a total,
// so a broken file does not flood the console.
const MAX_RULE_WARNINGS = 20;

// Where things live. The storage key is shared with the popup.
const NETWORK_RULES_PATH = "rules/network.json";
const ALLOWLIST_STORAGE_KEY = "allowlist";

// Settings for hiding ads with CSS. Kept here so every setting is in one place.
const HIDE_CSS = "{display:none!important}"; // what each hidden element gets
const MAX_CSS_CACHE = 200;                    // most hostnames whose CSS we remember
const HIDE_RULES_PATH = "rules/hide.json";    // made by tools/convert.py (may be missing)
const BASE_HIDE_PATH = "base-hide.json";      // small built-in list, always used

// Settings for the popup's "what was blocked" list.
// Each tab's list is saved in chrome.storage.session under "blocked:<tab id>".
// Session storage lives in memory only and is wiped when Chrome closes, so the
// list of blocked addresses is never written to disk. popup.js has the same
// prefix (BLOCKED_KEY_PREFIX), so change both together.
const BLOCKED_KEY_PREFIX = "blocked:";
const MAX_BLOCKED_ENTRIES = 200;            // most different addresses kept per tab
const META_RULES_PATH = "rules/meta.json";  // tells us how many converted rules are blocks

// ------------------------------------------------------------- load helpers

// lib/sites.js holds the shared helper functions. If it fails to load we log it
// and carry on, because the rules below do not need it.
try {
  importScripts("lib/sites.js");
} catch (e) {
  console.warn("Ad-Blocker: could not load lib/sites.js", e);
}

// ------------------------------------------------------------- rule queue

// Chrome can get confused if two rule updates run at the same time (for example
// the allowlist changing while the big rule list is loading). So every rule
// change goes through this queue and runs one after another.
let ruleWork = Promise.resolve();

function queueRuleWork(task) {
  const result = ruleWork.then(task);
  // Keep the queue going even if this task fails.
  ruleWork = result.catch(() => {});
  return result;
}

// ------------------------------------------------------------- badge

// Makes Chrome show the number of blocked requests on the toolbar icon, counted
// per tab. This setting is not saved by Chrome, so it is set on install and on
// every browser start.
async function showBlockedCountOnIcon() {
  try {
    await chrome.declarativeNetRequest.setExtensionActionOptions({
      displayActionCountAsBadgeText: true,
    });
  } catch (e) {
    console.warn("Ad-Blocker: could not turn on the badge count", e);
  }
}

// ------------------------------------------------------------- converted rules

// Reads rules/network.json from inside the extension.
// Returns an array of rules. A missing or broken file gives an empty array,
// because "no converted rules yet" is a normal state, not an error.
async function readConvertedRules() {
  let response;
  try {
    response = await fetch(chrome.runtime.getURL(NETWORK_RULES_PATH));
  } catch (e) {
    return []; // the file is not there
  }
  if (!response.ok) return [];

  let rules;
  try {
    rules = await response.json();
  } catch (e) {
    console.warn("Ad-Blocker: " + NETWORK_RULES_PATH + " is not valid JSON, ignoring it");
    return [];
  }
  if (!Array.isArray(rules)) {
    console.warn("Ad-Blocker: " + NETWORK_RULES_PATH + " should be a list of rules, ignoring it");
    return [];
  }
  return rules;
}

// Adds one chunk of rules. If Chrome rejects the whole chunk (one bad rule is
// enough), try the rules one at a time and skip the bad ones.
// Returns how many rules were added.
async function addRuleChunk(chunk, warnings) {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: chunk });
    return chunk.length;
  } catch (chunkError) {
    let added = 0;
    for (const rule of chunk) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
        added++;
      } catch (ruleError) {
        warnings.count++;
        if (warnings.count <= MAX_RULE_WARNINGS) {
          console.warn("Ad-Blocker: skipped bad rule id " + rule.id + ":", ruleError.message);
        }
      }
    }
    return added;
  }
}

// Replaces all converted dynamic rules with the ones in rules/network.json.
// The allowlist rule is never touched here.
async function loadConvertedRules() {
  // Remove the old converted rules first (every dynamic rule except the allowlist).
  // This is also what happens when the file is gone: old rules are cleaned out.
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const oldIds = existing
    .map((rule) => rule.id)
    .filter((id) => id !== ALLOWLIST_RULE_ID);
  if (oldIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldIds });
  }

  let rules = await readConvertedRules();
  if (rules.length === 0) {
    console.log("Ad-Blocker: no converted rules, using the built-in rules only");
    return;
  }

  // Never let a file take the allowlist id, and never go past Chrome's limit.
  rules = rules.filter((rule) => rule && rule.id !== ALLOWLIST_RULE_ID);
  if (rules.length > MAX_CONVERTED_RULES) {
    console.warn("Ad-Blocker: too many rules, keeping the first " + MAX_CONVERTED_RULES);
    rules = rules.slice(0, MAX_CONVERTED_RULES);
  }

  // Send the rules in chunks.
  const warnings = { count: 0 };
  let added = 0;
  for (let start = 0; start < rules.length; start += RULE_CHUNK_SIZE) {
    const chunk = rules.slice(start, start + RULE_CHUNK_SIZE);
    added += await addRuleChunk(chunk, warnings);
  }

  console.log("Ad-Blocker: loaded " + added + " converted rules");
  if (warnings.count > 0) {
    console.warn("Ad-Blocker: skipped " + warnings.count + " bad rules in total");
  }
}

// ------------------------------------------------------------- allowlist rule

// Cleans one allowlist entry: lowercase, no leading "www.". Returns null if it
// does not look like a hostname, so one odd entry cannot break the whole rule.
function cleanSiteName(entry) {
  if (typeof entry !== "string") return null;
  const site = entry.trim().toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(site)) return null;
  return site;
}

// Rebuilds the single allowlist rule from what is saved in storage.
// With sites in the list: an "allowAllRequests" rule for those sites. With an
// empty list: the rule is removed.
async function rebuildAllowlistRule() {
  const data = await chrome.storage.local.get(ALLOWLIST_STORAGE_KEY);
  const saved = Array.isArray(data[ALLOWLIST_STORAGE_KEY]) ? data[ALLOWLIST_STORAGE_KEY] : [];

  // Clean the names and drop duplicates.
  const sites = [];
  for (const entry of saved) {
    const site = cleanSiteName(entry);
    if (site && sites.indexOf(site) === -1) sites.push(site);
  }

  if (sites.length === 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ALLOWLIST_RULE_ID],
    });
    return;
  }

  // Removing and adding the same id in one call swaps the rule in one step.
  // requestDomains also matches subdomains. main_frame and sub_frame mean the
  // page itself and any frames inside it; allowAllRequests then lets everything
  // that page loads through.
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ALLOWLIST_RULE_ID],
    addRules: [
      {
        id: ALLOWLIST_RULE_ID,
        priority: ALLOWLIST_PRIORITY,
        action: { type: "allowAllRequests" },
        condition: {
          requestDomains: sites,
          resourceTypes: ["main_frame", "sub_frame"],
        },
      },
    ],
  });
}

// ------------------------------------------------------------- hiding ads (CSS)

// Reads one JSON file from inside the extension. A missing or broken file gives
// null, because "the file is not there yet" is a normal state.
async function readExtensionJson(path) {
  try {
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    return null;
  }
}

// True for a normal object like {"a": 1} (not null, not a list).
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Looks up a key in an object, but only if the object really owns it. This stops
// a hostname like "constructor" from finding something built into JavaScript.
function ownValue(object, key) {
  if (!isPlainObject(object)) return undefined;
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

// Checks that every bracket and quote in a selector is closed properly.
// "div[bad" has a "[" that never closes. A browser reads CSS in one stream, so
// an open bracket or quote does not stop at the end of the line: it keeps going
// into the next rules and swallows them. So selectors like that must never reach
// the stylesheet. This walks the text once:
//   - inside a quote (' or "), only the closing quote matters;
//   - a backslash escapes the next character (so \" is not a quote);
//   - "[" and "(" go on a stack, and "]" and ")" must match the top of it.
// Returns true when everything is closed and nothing is mismatched.
function isBalancedSelector(selector) {
  const stack = [];
  let quote = null; // the quote character we are inside, or null
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "\\") {
      i++; // skip the escaped character
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[" || ch === "(") {
      stack.push(ch);
    } else if (ch === "]" || ch === ")") {
      const open = stack.pop();
      if ((ch === "]" && open !== "[") || (ch === ")" && open !== "(")) return false;
    }
  }
  return quote === null && stack.length === 0;
}

// Cleans a list of selectors: keeps only text, drops empty ones and duplicates.
// A selector with "{", "}" or a line break could break out of its own CSS rule,
// so those are dropped too. Real selectors never contain them. Selectors with
// an unclosed bracket or quote are dropped as well (see isBalancedSelector).
function cleanSelectors(list) {
  const seen = new Set();
  const result = [];
  if (!Array.isArray(list)) return result;
  for (const item of list) {
    if (typeof item !== "string") continue;
    const selector = item.trim();
    if (selector === "" || /[{}\n\r]/.test(selector)) continue;
    if (!isBalancedSelector(selector)) continue;
    if (seen.has(selector)) continue;
    seen.add(selector);
    result.push(selector);
  }
  return result;
}

// Turns selectors into CSS text, ONE RULE PER SELECTOR.
// Why not one big rule like "a, b, c {display:none}"? In CSS, if any single
// selector in a comma list is invalid, the browser throws away the whole rule.
// One bad selector out of 13,000 would then switch off all the others. With one
// rule each, an invalid selector only cancels its own line.
// One kind of bad selector is different: an unclosed bracket or quote makes the
// browser read on into the next rules. cleanSelectors removes those before this
// function ever sees them, so every line here is safe on its own.
function selectorsToCss(selectors) {
  return selectors.map((selector) => selector + HIDE_CSS).join("\n");
}

// The hide data, loaded once per worker life. The promise is cached, so the two
// files are read and the big generic CSS string is built only the first time a
// page asks. After that every page reuses the same string. If the worker is
// stopped and started again, this is simply rebuilt.
// Shape: { generic: [selectors], genericCss: "text", sites: {...}, siteExceptions: {...} }
let hideDataPromise = null;

function getHideData() {
  if (!hideDataPromise) hideDataPromise = loadHideData();
  return hideDataPromise;
}

async function loadHideData() {
  const base = await readExtensionJson(BASE_HIDE_PATH);
  const converted = await readExtensionJson(HIDE_RULES_PATH);

  // base-hide.json is always merged in, so a few common ad boxes are hidden
  // even before tools/convert.py has been run. cleanSelectors removes duplicates.
  const generic = cleanSelectors(
    [].concat(
      isPlainObject(base) && Array.isArray(base.generic) ? base.generic : [],
      isPlainObject(converted) && Array.isArray(converted.generic) ? converted.generic : []
    )
  );

  return {
    generic,
    genericCss: selectorsToCss(generic),
    sites: isPlainObject(converted) && isPlainObject(converted.sites) ? converted.sites : {},
    siteExceptions:
      isPlainObject(converted) && isPlainObject(converted.siteExceptions)
        ? converted.siteExceptions
        : {},
  };
}

// Gathers the selectors a table has for a hostname and for each parent domain
// (a.b.example.com, b.example.com, example.com).
function collectForHost(table, hostname) {
  let all = [];
  for (const domain of parentDomains(hostname)) {
    const list = ownValue(table, domain);
    if (Array.isArray(list)) all = all.concat(list);
  }
  return cleanSelectors(all);
}

// Generic CSS with some selectors left out, remembered per hostname.
// A Map remembers the order things were added, so the first key is the oldest.
// When the Map is full we delete the oldest one, which keeps memory small.
const filteredCssCache = new Map();

function filteredGenericCss(data, hostname, exceptions) {
  if (filteredCssCache.has(hostname)) return filteredCssCache.get(hostname);
  const css = selectorsToCss(data.generic.filter((selector) => !exceptions.has(selector)));
  if (filteredCssCache.size >= MAX_CSS_CACHE) {
    filteredCssCache.delete(filteredCssCache.keys().next().value);
  }
  filteredCssCache.set(hostname, css);
  return css;
}

// Builds the full stylesheet text for one hostname:
//   generic selectors (minus this site's exceptions) + this site's own selectors.
// Sites without exceptions (almost all of them) just reuse the generic string
// that was built once.
async function getCssForHostname(hostname) {
  const data = await getHideData();

  const exceptions = new Set(collectForHost(data.siteExceptions, hostname));
  const genericCss =
    exceptions.size > 0 ? filteredGenericCss(data, hostname, exceptions) : data.genericCss;

  const siteSelectors = collectForHost(data.sites, hostname).filter(
    (selector) => !exceptions.has(selector)
  );

  const parts = [genericCss];
  if (siteSelectors.length > 0) parts.push(selectorsToCss(siteSelectors));
  return parts.filter((part) => part !== "").join("\n");
}

// Returns the hostname of an http or https address (like "www.cnn.com"), or null.
// Unlike siteFromUrl it keeps the "www.", so lookups use the exact host.
function httpHostname(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname ? parsed.hostname.toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

// Handles one "hide" message from content.js. Any problem is ignored on purpose:
// the page may have closed, or the tab may be a page we are not allowed to touch.
async function handleHideMessage(sender) {
  try {
    if (!sender || !sender.tab || typeof sender.tab.id !== "number") return;
    const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;

    // Which page is this? The top page decides about the allowlist, so a frame
    // inside an allowlisted page is left alone too. Not http/https: do nothing.
    const pageUrl = frameId === 0 ? sender.url : sender.tab.url;
    const pageSite = siteFromUrl(pageUrl);
    if (pageSite === null) return;

    // Read the allowlist fresh each time (reading storage is cheap), because
    // the worker can be stopped and started and must not rely on old copies.
    const data = await chrome.storage.local.get(ALLOWLIST_STORAGE_KEY);
    if (isAllowlisted(pageSite, data[ALLOWLIST_STORAGE_KEY])) return;

    // Site-specific selectors use the frame's own host (an ad frame has its own
    // address). If the frame has no web address (like about:blank), use the page's.
    const hostname = httpHostname(sender.url) || httpHostname(pageUrl);
    if (!hostname) return;

    const css = await getCssForHostname(hostname);
    if (css === "") return;

    // origin "USER" puts the CSS in the user style layer. Page styles cannot
    // override it, even if the page uses its own "!important" rules.
    await chrome.scripting.insertCSS({
      target: { tabId: sender.tab.id, frameIds: [frameId] },
      css,
      origin: "USER",
    });
  } catch (e) {
    // Ignored on purpose (see above).
  }
}

// ------------------------------------------------------------- blocked list

// Chrome's onRuleMatchedDebug event tells us the real address of every request a
// rule matched. It only exists for extensions loaded unpacked (from a folder);
// a store install never gets it, and then the popup list simply stays empty.
//
// The event fires for every matched rule, allow rules too, so we keep only the
// block rules. Which converted rules are blocks depends on rules/meta.json, so
// that number is read once per worker life and reused.
let blockRuleCountPromise = null;

function getBlockRuleCount() {
  if (!blockRuleCountPromise) {
    blockRuleCountPromise = readExtensionJson(META_RULES_PATH).then((meta) =>
      isPlainObject(meta) && typeof meta.blockRules === "number" ? meta.blockRules : 0
    );
  }
  return blockRuleCountPromise;
}

// Saving is "read the list, change it, write it back". If two blocks arrived at
// the same moment, both could read the old list and one change would be lost.
// So, like the rule queue above, every change to the lists runs one at a time.
// It is a separate queue so the list never waits for the big rule load.
let blockedWork = Promise.resolve();

function queueBlockedWork(task) {
  const result = blockedWork.then(task);
  blockedWork = result.catch(() => {});
  return result;
}

// Adds one blocked request to its tab's list. The same address and type just
// gets its count raised, so a tracker that fires 20 times is one line, not 20.
async function recordBlocked(info) {
  const request = info && info.request;
  if (!request || typeof request.tabId !== "number" || request.tabId < 0) return; // not from a tab
  if (!isBlockRule(info.rule, await getBlockRuleCount())) return;
  const address = shortAddress(request.url);
  if (!address) return;
  const type = typeof request.type === "string" ? request.type : "other";

  const key = BLOCKED_KEY_PREFIX + request.tabId;
  const data = await chrome.storage.session.get(key);
  const list = Array.isArray(data[key]) ? data[key] : [];
  const same = list.find(
    (entry) => entry.host === address.host && entry.path === address.path && entry.type === type
  );
  if (same) {
    same.count++;
  } else if (list.length < MAX_BLOCKED_ENTRIES) {
    list.push({ host: address.host, path: address.path, type, count: 1 });
  } else {
    return; // list is full; the count in the popup still includes it
  }
  await chrome.storage.session.set({ [key]: list });
}

// Empties a tab's list (a new page started loading, or the tab was closed).
async function clearBlocked(tabId) {
  if (typeof tabId !== "number") return;
  await chrome.storage.session.remove(BLOCKED_KEY_PREFIX + tabId);
}

// ------------------------------------------------------------- events

// Everything here is wrapped in try/catch so the worker never throws while it
// starts. Listeners must be added right away (not later), or Chrome can miss
// the event that woke the worker up.
try {
  // Runs on install, on update, and every time the extension is reloaded.
  chrome.runtime.onInstalled.addListener(() => {
    showBlockedCountOnIcon();

    queueRuleWork(loadConvertedRules).catch((e) => {
      console.warn("Ad-Blocker: could not load converted rules", e);
    });

    queueRuleWork(rebuildAllowlistRule).catch((e) => {
      console.warn("Ad-Blocker: could not set the allowlist rule", e);
    });
  });

  // Runs when the browser starts. Dynamic rules are saved by Chrome, so only
  // the badge setting needs to be set again.
  chrome.runtime.onStartup.addListener(() => {
    showBlockedCountOnIcon();
  });

  // When the popup changes the saved allowlist, update the rule to match.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[ALLOWLIST_STORAGE_KEY]) return;
    queueRuleWork(rebuildAllowlistRule).catch((e) => {
      console.warn("Ad-Blocker: could not update the allowlist rule", e);
    });
  });

  // content.js asks for hiding CSS when a page or frame starts loading.
  // Returning nothing (not true) tells Chrome we send no reply.
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message && message.type === "hide") handleHideMessage(sender);
  });
} catch (e) {
  console.warn("Ad-Blocker: could not start", e);
}

// The blocked list's events are in their own block, so a missing event (like
// onRuleMatchedDebug in a store install) cannot stop the listeners above.
try {
  const dnr = chrome.declarativeNetRequest;
  if (dnr && dnr.onRuleMatchedDebug) {
    dnr.onRuleMatchedDebug.addListener((info) => {
      queueBlockedWork(() => recordBlocked(info)).catch(() => {}); // a closed tab is fine
    });
  }

  // "loading" means a new page (or a reload) started in that tab, so the old
  // list no longer belongs to what is on screen.
  if (chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo && changeInfo.status === "loading") {
        queueBlockedWork(() => clearBlocked(tabId)).catch(() => {});
      }
    });
  }
  if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => {
      queueBlockedWork(() => clearBlocked(tabId)).catch(() => {});
    });
  }
} catch (e) {
  console.warn("Ad-Blocker: could not start the blocked list", e);
}
