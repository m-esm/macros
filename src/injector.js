// Macros — injector.js (MAIN world)
// Responsibility: Intercept Wolt category API fetches and pass data to
// content.js (ISOLATED world) via DOM elements.
//
// CustomEvent.detail does NOT cross the MAIN↔ISOLATED world boundary.
// Instead, intercepted data is written to <script data-hw-event> elements
// and an empty Event('hw:data') notifies content.js to consume them.
(() => {
  const _fetch = window.fetch;

  function postToContentScript(type, payload) {
    const el = document.createElement('script');
    el.type = 'application/json';
    el.dataset.hwEvent = type;
    el.textContent = JSON.stringify(payload);
    document.documentElement.appendChild(el);
    window.dispatchEvent(new Event('hw:data'));
  }

  // Click proxy: content.js (ISOLATED) can't trigger React handlers directly.
  // It writes the target href to a data attribute and fires hw:click for us.
  // We find the element by exact href match (no CSS selector escaping issues)
  // and acknowledge the result back to content.js via hw:click-ack.
  window.addEventListener('hw:click', () => {
    const root = document.documentElement;
    const href = root.dataset.hwClickHref;
    delete root.dataset.hwClickHref;
    if (!href) {
      root.dataset.hwClickResult = 'miss';
      window.dispatchEvent(new Event('hw:click-ack'));
      return;
    }
    const cards = [...document.querySelectorAll('a[aria-haspopup="dialog"]')];
    const target = cards.find(a => a.getAttribute('href') === href);
    if (target) {
      target.click();
      root.dataset.hwClickResult = 'ok';
    } else {
      root.dataset.hwClickResult = 'miss';
    }
    window.dispatchEvent(new Event('hw:click-ack'));
  });

  // Intercept Wolt category API fetches (triggered by scroll pagination)
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    const url = args[0]?.url ?? (typeof args[0] === 'string' ? args[0] : '');
    if (
      res.ok &&
      res.headers.get('content-type')?.includes('application/json') &&
      url.includes('/consumer-assortment/v1/') &&
      url.includes('/categories/slug/')
    ) {
      const slug = url.match(/categories\/slug\/([^?/]+)/)?.[1] ?? 'unknown';
      res.clone().json().then(data => {
        postToContentScript('items', {
          slug,
          name: data.category?.name ?? slug,
          items: data.items ?? [],
        });
      }).catch(() => {});
    }
    return res;
  };
})();
