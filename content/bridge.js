'use strict';

/**
 * Bocchi Privacy Shield - Isolated World Bridge
 *
 * Runs in ISOLATED world at document_start.
 * Reads egress IP timezone cached in chrome.storage.local by the background service worker
 * and synchronously synchronizes it to the MAIN world stealth engine via custom event.
 */
(() => {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    return;
  }

  function dispatchTimezone(tz) {
    if (!tz || typeof tz !== 'string') return;
    try {
      const event = new CustomEvent('__bocchi_tz_sync__', {
        detail: { timezone: tz }
      });
      document.dispatchEvent(event);
    } catch (_) {}
  }

  // Initial read from chrome.storage.local (supports new timezone key with legacy fallback)
  chrome.storage.local.get(['timezone', 'targetTimezone'], (res) => {
    const tz = (res && (res.timezone || res.targetTimezone));
    if (tz) {
      dispatchTimezone(tz);
    } else if (chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({ type: 'GET_TIMEZONE' }, (response) => {
          if (response && response.timezone) {
            dispatchTimezone(response.timezone);
          }
        });
      } catch (_) {}
    }
  });

  // Listen for real-time changes
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.timezone || changes.targetTimezone)) {
        const newTz = (changes.timezone && changes.timezone.newValue) ||
                      (changes.targetTimezone && changes.targetTimezone.newValue);
        if (newTz) {
          dispatchTimezone(newTz);
        }
      }
    });
  }
})();
