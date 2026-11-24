// lib/sites.js
//
// Small helper functions about websites, shared by background.js, popup.js
// and the node tests.
//
// These are "pure" functions: they only take values in and give values back.
// They never call chrome.* APIs, so they can be tested with plain node.
//
// How this file is loaded:
//   - background.js:  importScripts("lib/sites.js")   (functions become globals)
//   - popup.html:     <script src="../lib/sites.js">  (same thing)
//   - node tests:     require("../lib/sites.js")      (uses module.exports at the bottom)
//
// Note: importScripts shares one global scope with background.js, so a
// top-level name used here must not be declared again in background.js.

// Milliseconds in one day. Not a setting, just the length of a day.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Remove a leading "www." from a hostname (and make it lowercase).
// Used by several functions below so they all treat "www.x.com" and "x.com" the same.
function stripWww(hostname) {
  return String(hostname).toLowerCase().replace(/^www\./, "");
}

// siteFromUrl("https://www.example.com/page") -> "example.com"
// Returns null for anything that is not an http or https page
// (chrome://, file://, about:blank, broken text, and so on).
function siteFromUrl(url) {
  if (typeof url !== "string") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return null; // not a valid URL at all
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return stripWww(parsed.hostname);
}

// isAllowlisted("news.example.com", ["example.com"]) -> true
// A site matches an allowlist entry if it is the same name, or a subdomain of it.
// The "." check matters: "badexample.com" must NOT match "example.com".
function isAllowlisted(hostname, allowlist) {
  if (typeof hostname !== "string" || hostname === "") return false;
  if (!Array.isArray(allowlist)) return false;
  const host = stripWww(hostname);
  for (const entry of allowlist) {
    if (typeof entry !== "string" || entry === "") continue;
    const site = stripWww(entry);
    if (host === site || host.endsWith("." + site)) return true;
  }
  return false;
}

// parentDomains("a.b.example.com") -> ["a.b.example.com", "b.example.com", "example.com"]
// Used to find hiding selectors that belong to a site or to any parent of it.
// It stops before the bare TLD ("com"), because a rule for all of ".com" makes no sense.
function parentDomains(hostname) {
  if (typeof hostname !== "string" || hostname === "") return [];
  const host = hostname.toLowerCase();
  // IP addresses and one-word hosts (like "localhost") have no parents.
  if (host.indexOf(":") !== -1 || /^\d+(\.\d+){3}$/.test(host)) return [host];
  const parts = host.split(".");
  if (parts.length < 2) return [host];
  const result = [];
  // Keep removing the left-most label until only two labels are left.
  for (let i = 0; i <= parts.length - 2; i++) {
    result.push(parts.slice(i).join("."));
  }
  return result;
}

// Turns "2026-11-24" into a Date at local midnight. Returns null if it is not a real date.
function parseIsoDate(text) {
  if (typeof text !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(year, month - 1, day);
  // new Date rolls over bad dates (like month 13), so check it did not.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

// ruleAgeDays("2026-11-01", new Date(2026, 10, 24)) -> 23
// Whole days between the build date and today, using local dates (not the time of day).
// Never negative. Returns null if the build date is missing or not a real date.
function ruleAgeDays(builtIsoDate, now) {
  const built = parseIsoDate(builtIsoDate);
  if (!built) return null;
  const current = now instanceof Date ? now : new Date();
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate());
  // Math.round keeps the answer whole even when a daylight saving change makes a day 23 or 25 hours.
  const days = Math.round((today - built) / MS_PER_DAY);
  return Math.max(0, days);
}

// isRulesStale("2026-10-01", now, 30) -> true when the rules are 30 or more days old.
// If the date is missing or broken we cannot trust the rules, so they count as stale.
// (popup.js owns the RULES_STALE_DAYS number and passes it in.)
function isRulesStale(builtIsoDate, now, staleDays) {
  const age = ruleAgeDays(builtIsoDate, now);
  if (age === null) return true;
  return age >= staleDays;
}

// countBlocked(matches, 120) -> how many of the matched rules were "block" rules.
// matches is the list from chrome.declarativeNetRequest.getMatchedRules. Each item looks like
//   { rule: { ruleId: 5, rulesetId: "_dynamic" }, tabId: 1, timeStamp: 123 }
// (an item with ruleId and rulesetId directly on it also works, and so does the whole
// result object with a rulesMatchedInfo list inside).
// Which ones count:
//   - rulesetId "base": every base rule is a block rule.
//   - rulesetId "_dynamic": converted rules numbered 1..blockRuleCount are blocks.
//     Higher numbers are allow rules (exceptions), and the allowlist rule (a very
//     high number) is not a block either.
function countBlocked(matchedRules, blockRuleCount) {
  let list = matchedRules;
  if (list && !Array.isArray(list) && Array.isArray(list.rulesMatchedInfo)) {
    list = list.rulesMatchedInfo;
  }
  if (!Array.isArray(list)) return 0;
  const limit = typeof blockRuleCount === "number" ? blockRuleCount : 0;
  let count = 0;
  for (const item of list) {
    if (!item) continue;
    const rule = item.rule || item;
    if (rule.rulesetId === "base") {
      count++;
    } else if (rule.rulesetId === "_dynamic" && rule.ruleId >= 1 && rule.ruleId <= limit) {
      count++;
    }
  }
  return count;
}

// Let node tests use "require", while browsers and importScripts just see the globals above.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    siteFromUrl,
    isAllowlisted,
    parentDomains,
    ruleAgeDays,
    isRulesStale,
    countBlocked,
  };
}
