// Isolated-world script: content.js runs in the page and cannot read chrome.storage, so this
// script mirrors the popup options onto <html>: on/off attributes read by content.js and
// content.css, and the per-level colors as CSS variables.
// The main switch (`enabled`) turns everything off at once, without losing the other settings.
// LEVELS, DEFAULTS and tintOf come from options.js, loaded just before.

function mirror(options) {
  const root = document.documentElement;
  const on = (flag) => (options.enabled && flag ? 'on' : 'off');
  root.dataset.lscCollapse = on(options.collapse);
  root.dataset.lscColors = on(options.colors);
  for (let level = 1; level <= LEVELS; level++) {
    root.style.setProperty(`--lsc-tint-${level}`, tintOf(options, level));
    root.style.setProperty(`--lsc-color-${level}`, levelColors(options)[level - 1]);
  }
}

// Popup actions (Tout replier, Tout déplier, extension turned on): relay to content.js.
// Answering tells the popup this tab is a Linear page (no answer reads as an error there).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'ping') sendResponse({ ok: true });
  if (['collapse-all', 'expand-all', 'enable-sub-issues'].includes(message?.action)) {
    window.postMessage({ source: 'lsc-bridge', action: message.action }, location.origin);
    sendResponse({ ok: true });
  }
});

chrome.storage.local.get(DEFAULTS, mirror);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') chrome.storage.local.get(DEFAULTS, mirror);
});
