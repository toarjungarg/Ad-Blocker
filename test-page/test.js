// test-page/test.js
//
// The script for the test page (index.html). It does two jobs:
//   1. Network test: sends one request to every server in base-rules.json and
//      shows a row for each one: "blocked" or "loaded".
//   2. Hiding test: checks which fake ad boxes on the page are hidden, and that
//      the real content box is still showing.
//
// This is a normal web page script (not an extension script), so it cannot ask
// the extension anything. It can only look at what happened to the page.

// ---------------------------------------------------------------- settings

// How long to wait for a server before giving up, in milliseconds.
const REQUEST_TIMEOUT_MS = 8000;

// Hiding CSS is added by the extension a moment after the page starts, so the
// hiding check runs a few times: HIDE_RECHECK_TIMES times, once every HIDE_RECHECK_MS.
const HIDE_RECHECK_MS = 700;
const HIDE_RECHECK_TIMES = 5;

// Where the rule files are, relative to this page (the page is in test-page/).
const RULES_URL = "../base-rules.json";
const HIDE_URL = "../base-hide.json";

// ---------------------------------------------------------------- small helpers

// Makes a table row with two text cells. The second cell gets a CSS class
// (like "blocked") so the colour shows. Returns the second cell so it can be changed later.
function addRow(tableBody, firstText, secondText, secondClass) {
  const row = document.createElement("tr");
  const first = document.createElement("td");
  const second = document.createElement("td");
  first.textContent = firstText;
  second.textContent = secondText;
  second.className = secondClass;
  row.appendChild(first);
  row.appendChild(second);
  tableBody.appendChild(row);
  return second;
}

// Fetches a JSON file from the repo root. Throws if it cannot be read.
async function readJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

// ---------------------------------------------------------------- 1. network test

// Sends one request to a server and returns "blocked", "loaded" or "timeout".
//
// fetch with mode "no-cors" lets the request go to another site without needing
// its permission. If the extension blocks it, fetch fails with an error. If it
// goes through, we get an answer we cannot read (even a 404 page counts as
// "loaded"). That is exactly what we want to know: did the request get out?
async function tryRequest(server) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // The random part stops the browser from reusing an old answer.
    const url = "https://" + server + "/ads/test.js?t=" + Date.now();
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: controller.signal });
    return "loaded";
  } catch (e) {
    return e && e.name === "AbortError" ? "timeout" : "blocked";
  } finally {
    clearTimeout(timer);
  }
}

// Reads base-rules.json, makes one row per server, and fills each row in as its
// request finishes.
async function runNetworkTest() {
  const body = document.querySelector("#request-table tbody");
  const summary = document.getElementById("request-summary");

  let rules;
  try {
    rules = await readJson(RULES_URL);
  } catch (e) {
    summary.textContent = "Could not read base-rules.json (" + e.message + "). " +
      "Start the page with: python3 -m http.server 8000 (from the repo root).";
    summary.className = "summary bad";
    return;
  }

  // Each rule's urlFilter looks like "||doubleclick.net^". Take the server name out.
  const servers = [];
  for (const rule of rules) {
    const filter = rule && rule.condition && rule.condition.urlFilter;
    const match = /^\|\|(.+)\^$/.exec(filter || "");
    if (match) servers.push(match[1]);
  }

  const counts = { blocked: 0, loaded: 0, timeout: 0 };
  const total = servers.length;

  function showSummary() {
    const done = counts.blocked + counts.loaded + counts.timeout;
    summary.textContent = counts.blocked + " of " + total + " blocked, " +
      counts.loaded + " loaded, " + counts.timeout + " no answer" +
      (done < total ? " (still waiting for " + (total - done) + ")" : "");
  }
  showSummary();

  // Add all the rows first, then start every request at the same time.
  for (const server of servers) {
    const cell = addRow(body, server, "waiting...", "waiting");
    tryRequest(server).then((result) => {
      counts[result]++;
      if (result === "timeout") {
        cell.textContent = "no answer (timed out)";
        cell.className = "waiting";
      } else {
        cell.textContent = result;
        cell.className = result; // "blocked" is green, "loaded" is red
      }
      showSummary();
    });
  }
}

// ---------------------------------------------------------------- 2. hiding test

// Is this element hidden? The extension hides things with display:none.
function isHidden(element) {
  return window.getComputedStyle(element).display === "none";
}

// Looks at every fake ad box and the real content box, and redraws the table.
function checkHiding() {
  const body = document.querySelector("#hide-table tbody");
  const summary = document.getElementById("hide-summary");
  body.textContent = ""; // clear the old rows

  let hiddenCount = 0;
  const boxes = document.querySelectorAll("[data-selector]");
  for (const box of boxes) {
    const selector = box.getAttribute("data-selector");
    if (isHidden(box)) {
      hiddenCount++;
      addRow(body, selector, "hidden", "good");
    } else {
      addRow(body, selector, "visible", "bad");
    }
  }

  // The real content box should stay visible, so here "visible" is the good answer.
  const real = document.getElementById("real-content");
  const realOk = !isHidden(real);
  addRow(body, "real content box", realOk ? "visible (correct)" : "hidden (wrong)", realOk ? "good" : "bad");

  summary.textContent = hiddenCount + " of " + boxes.length + " fake ads hidden. " +
    "Real content is " + (realOk ? "still showing." : "HIDDEN, which is wrong.");
}

// Safety check on the test page itself: each box must really match the selector
// written on it, and every selector in base-hide.json should have a box.
async function checkTestPageCoverage() {
  const warnings = [];

  const boxes = document.querySelectorAll("[data-selector]");
  const tested = [];
  for (const box of boxes) {
    const selector = box.getAttribute("data-selector");
    tested.push(selector);
    let matches = false;
    try {
      matches = box.matches(selector);
    } catch (e) {
      matches = false;
    }
    if (!matches) warnings.push("Test box does not match its own selector: " + selector);
  }

  try {
    const hide = await readJson(HIDE_URL);
    const missing = (hide.generic || []).filter((selector) => tested.indexOf(selector) === -1);
    if (missing.length > 0) {
      warnings.push("No test box yet for: " + missing.join(", "));
    }
  } catch (e) {
    warnings.push("Could not read base-hide.json (" + e.message + ").");
  }

  document.getElementById("hide-warnings").textContent = warnings.join(" ");
}

// Runs the hiding check now and a few more times, because the extension adds its
// CSS a short moment after the page begins to load.
function startHidingChecks() {
  checkHiding();
  let runs = 1;
  const timer = setInterval(() => {
    checkHiding();
    runs++;
    if (runs > HIDE_RECHECK_TIMES) clearInterval(timer);
  }, HIDE_RECHECK_MS);
}

// ---------------------------------------------------------------- start

document.getElementById("recheck-button").addEventListener("click", checkHiding);
startHidingChecks();
checkTestPageCoverage();
runNetworkTest();
