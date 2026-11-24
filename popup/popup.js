// popup/popup.js
//
// The code behind the toolbar popup (popup.html). When you click the icon it:
//   1. finds the tab you are on and works out its site name,
//   2. shows a switch: on = ads are blocked on this site, off = the site is on the allowlist,
//   3. shows how many requests were blocked on this page,
//   4. shows when the filter rules were built, in orange if they are old.
//
// The helper functions (siteFromUrl, isAllowlisted, isRulesStale, countBlocked) come
// from lib/sites.js, which popup.html loads first. Names that file already uses at
// the top level (MS_PER_DAY, stripWww, parseIsoDate) must not be declared again here.
//
// The "what text do we show" logic lives in small pure functions near the top, so
// node tests can run them. The part that talks to Chrome is at the bottom and only
// runs inside Chrome.

// ---------------------------------------------------------------- constants

// Rules older than this many days show in orange with a hint to rebuild them.
// The popup text and the stale check both read this one number.
const RULES_STALE_DAYS = 30;

// After the allowlist changes, the service worker (background.js) has to update
// its allowlist rule. That happens in the background, so we wait this long before
// reloading the tab. Without the wait the page could reload before the rule changed.
const RELOAD_DELAY_MS = 300;

// Where the converter writes the rules date and counts (relative to the extension folder).
const META_PATH = "rules/meta.json";

// How the build date is shown when there is a date, and the hint texts.
const HINT_BUILD = "Run tools/convert.py to build the full lists.";
const HINT_UPDATE = "Run tools/convert.py to update.";

// ------------------------------------------------- helpers from lib/sites.js

// In Chrome, popup.html loads lib/sites.js first, so its functions are globals.
// In node (tests) there are no globals, so we require the file instead.
// We keep them inside one object (not top-level const names) because declaring
// "const isAllowlisted" here would clash with the function of the same name in sites.js.
const siteHelpers = typeof require === "function"
  ? require("../lib/sites.js")
  : { siteFromUrl, isAllowlisted, ruleAgeDays, isRulesStale, countBlocked };

// ------------------------------------------------------ pure text functions

// Works out the "Rules from ..." line.
// meta is the parsed rules/meta.json, or null if that file is missing.
// Returns { text, hint, stale } where stale is true when the line should be orange.
function describeRules(meta, now, staleDays) {
  if (!meta || typeof meta !== "object") {
    return { text: "Using built-in rules only", hint: HINT_BUILD, stale: false };
  }
  const built = meta.built;
  if (typeof built !== "string" || built === "") {
    // The file exists but has no usable date, so we cannot trust how old it is.
    return { text: "Rules from an unknown date", hint: HINT_UPDATE, stale: true };
  }
  if (siteHelpers.ruleAgeDays(built, now) === null) {
    // There is text, but it is not a real date (like "soon"), so treat it the same as missing.
    return { text: "Rules from an unknown date", hint: HINT_UPDATE, stale: true };
  }
  const stale = siteHelpers.isRulesStale(built, now, staleDays);
  return {
    text: "Rules from " + built,
    hint: stale ? "Over " + staleDays + " days old. " + HINT_UPDATE : "",
    stale: stale,
  };
}

// Returns the new allowlist after the switch is flipped. It never changes the list it is given.
//   blockingOn true  -> the site must NOT be allowlisted: remove every entry that covers it,
//                       including a parent domain (an entry "example.com" covers "news.example.com").
//   blockingOn false -> add the site (exact name) unless an entry already covers it.
function nextAllowlist(allowlist, site, blockingOn) {
  const list = Array.isArray(allowlist) ? allowlist.slice() : [];
  if (blockingOn) {
    return list.filter(function (entry) {
      return !siteHelpers.isAllowlisted(site, [entry]);
    });
  }
  if (!siteHelpers.isAllowlisted(site, list)) list.push(site);
  return list;
}

// "Blocked on this page: 12". A null count means Chrome could not tell us.
function blockedText(count) {
  if (count === null || count === undefined) return "Blocked on this page: not available";
  return "Blocked on this page: " + count;
}

// The note under the switch for pages we cannot block.
const NOT_WEB_NOTE = "This page can't be blocked or allowed";

// Notes for the two ways flipping the switch can go wrong.
const SAVE_FAILED_NOTE = "Could not save. Please try again.";
const RELOAD_FAILED_NOTE = "Saved. Reload the page to see the change.";

// ------------------------------------------------------- the Chrome part

// Reads the rules date file. Returns the parsed object, or null if it is missing or broken.
async function loadMeta() {
  try {
    const response = await fetch(chrome.runtime.getURL(META_PATH));
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    return null; // file not there (rules not built yet) or not valid JSON
  }
}

// Asks Chrome which rules matched on this tab and counts the blocks.
// Chrome limits how often getMatchedRules can be called (only a small number of
// calls are allowed in a 10 minute window), so the call can fail. If it does we
// show "not available" instead of a wrong number.
async function loadBlockedCount(tabId, blockRules) {
  try {
    const result = await chrome.declarativeNetRequest.getMatchedRules({ tabId: tabId });
    return siteHelpers.countBlocked(result, blockRules || 0);
  } catch (e) {
    return null;
  }
}

// Reads the allowlist from storage (an array of site names).
async function loadAllowlist() {
  const data = await chrome.storage.local.get({ allowlist: [] });
  return Array.isArray(data.allowlist) ? data.allowlist : [];
}

function showNote(text) {
  const note = document.getElementById("note");
  note.textContent = text;
  note.hidden = text === "";
}

// Fills in the rules date lines.
function showRules(meta) {
  const info = describeRules(meta, new Date(), RULES_STALE_DAYS);
  const line = document.getElementById("rules-line");
  line.textContent = info.text;
  line.classList.toggle("stale", info.stale);
  document.getElementById("rules-hint").textContent = info.hint;
}

// Runs when the popup opens.
async function start() {
  const switchBox = document.getElementById("block-switch");

  // The "tabs" permission is NOT needed to read tab.url, because the manifest already
  // has host permission for <all_urls>. Chrome shows the url of any tab we have host
  // access to. On pages we have no access to (like chrome:// pages) tab.url is undefined.
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const site = tab ? siteHelpers.siteFromUrl(tab.url) : null; // siteFromUrl(undefined) is null

  const meta = await loadMeta();
  showRules(meta);

  if (!tab || site === null) {
    document.getElementById("site-name").textContent = "Not a website";
    switchBox.checked = false;
    switchBox.disabled = true;
    showNote(NOT_WEB_NOTE);
    document.getElementById("blocked-line").textContent = blockedText(0);
    return;
  }

  document.getElementById("site-name").textContent = site;

  let allowlist = await loadAllowlist();
  switchBox.checked = !siteHelpers.isAllowlisted(site, allowlist);
  switchBox.disabled = false;

  const count = await loadBlockedCount(tab.id, meta ? meta.blockRules : 0);
  document.getElementById("blocked-line").textContent = blockedText(count);

  // When the switch is flipped: save the new allowlist, then reload the tab so the
  // change shows. The switch stays disabled while we save so it cannot be clicked twice.
  switchBox.addEventListener("change", async function () {
    const blockingOn = switchBox.checked;
    switchBox.disabled = true;
    showNote("");
    // Step 1: save. Only a failure here puts the switch back, because only then
    // has nothing changed.
    try {
      allowlist = nextAllowlist(await loadAllowlist(), site, blockingOn);
      await chrome.storage.local.set({ allowlist: allowlist });
    } catch (e) {
      switchBox.checked = !blockingOn;
      switchBox.disabled = false;
      showNote(SAVE_FAILED_NOTE);
      return;
    }
    // Step 2: reload. The allowlist is already saved, so if the reload fails the
    // switch keeps its new position and we just ask the user to reload by hand.
    try {
      // Give background.js a moment to update its allowlist rule, then reload.
      await new Promise(function (resolve) { setTimeout(resolve, RELOAD_DELAY_MS); });
      await chrome.tabs.reload(tab.id);
      window.close(); // the old counts are out of date after a reload
    } catch (e) {
      switchBox.disabled = false;
      showNote(RELOAD_FAILED_NOTE);
    }
  });
}

// Only run the Chrome code inside Chrome. In node (tests) "chrome" does not exist.
if (typeof chrome !== "undefined" && chrome.tabs) {
  start();
}

// Let node tests use the pure functions above.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RULES_STALE_DAYS,
    describeRules,
    nextAllowlist,
    blockedText,
  };
}
