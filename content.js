// content.js
//
// A content script: Chrome runs this file inside every web page (and every frame
// inside a page) as soon as the page starts loading (run_at: document_start).
//
// It does one small thing: it tells the background worker "this page is
// loading, send me the hiding CSS". The worker works out which site this is from
// the message itself (Chrome tells it the page address), so nothing about the
// page is sent from here. This script does not read or change the page.
//
// The extension sends nothing off the computer. The message only goes from this
// page to the extension's own background worker, inside the browser.

try {
  // The reply is not needed, and errors are ignored on purpose. For example the
  // worker may be restarting for a moment, or the extension may have just been
  // reloaded. The page then simply loads without the hiding CSS.
  const sending = chrome.runtime.sendMessage({ type: "hide" });
  if (sending && typeof sending.catch === "function") sending.catch(() => {});
} catch (e) {
  // Chrome throws here when the extension was reloaded while the page was open.
}
