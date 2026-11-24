// background.js
//
// The service worker: the extension's background script. Chrome starts it when
// it is needed and stops it when it is idle, so it must not keep state in
// variables that it cannot rebuild.
//
// What it does (first version):
//   1. Turns on the blocked-count number on the toolbar icon.
//   2. Loads the converted EasyList rules from rules/network.json (if that file
//      exists) as dynamic rules, in chunks. Without the file, only the small
//      built-in list (base-rules.json) is used.
//   3. Keeps one extra "allowlist" rule up to date, so sites the user turned
//      blocking off for are left alone.
//
// Hiding ads with CSS comes in a later version.
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

// Used by the hiding code that is added later. Kept here so every setting
// is in one place.
const HIDE_CSS = "{display:none!important}"; // what each hidden element gets
const MAX_CSS_CACHE = 200;                    // most hostnames whose CSS we remember

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
} catch (e) {
  console.warn("Ad-Blocker: could not start", e);
}
