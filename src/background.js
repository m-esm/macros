// Macros — background.js (service worker)
// Proxies prodinfo fetches for content.js — service worker has full
// host_permissions access without CORS restrictions.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'hw:fetchProdinfo') {
    const { itemId, venueId } = msg;
    const url = `https://prodinfo.wolt.com/en/${venueId}/${itemId}?lang=en`;
    fetch(url)
      .then(async res => {
        if (res.status === 404) {
          return sendResponse({ html: null, error: null, notFound: true });
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} for ${url} body=${body.substring(0, 100)}`);
        }
        return res.text();
      })
      .then(html => { if (html) sendResponse({ html, error: null }); })
      .catch(err => sendResponse({ html: null, error: err.message }));
    return true;
  }

  return false;
});
