import { expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { generatePickerCode, handleCookiePickerRoute, hasActivePicker } from '../src/cookie-picker-routes';

test('a same-site cross-port browser request carries the picker cookie but cannot mutate the session', async () => {
  let removed = 0;
  const observed: Array<{ origin: string | null; cookiePresent: boolean; status: number; contentType: string | null }> = [];
  const bm = { getActiveSession: () => ({ getPage: () => ({ context: () => ({ clearCookies: async () => { removed++; } }) }) }) } as any;
  const picker = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const response = await handleCookiePickerRoute(new URL(request.url), request, bm);
    if (request.method === 'POST') observed.push({ origin: request.headers.get('origin'), cookiePresent: /(?:^|;\s*)gstack_picker=/.test(request.headers.get('cookie') ?? ''), status: response.status, contentType: request.headers.get('content-type') });
    if (request.method === 'GET' && response.status === 200) return new Response('<title>Synthetic authorized picker</title>', { headers: { 'Content-Type': 'text/html' } });
    return response;
  } });
  const attacker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<title>Synthetic cross-port source</title>', { headers: { 'Content-Type': 'text/html' } }) });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pickerOrigin = `http://127.0.0.1:${picker.port}`;
    const attackerOrigin = `http://127.0.0.1:${attacker.port}`;
    await page.goto(`${pickerOrigin}/cookie-picker?code=${generatePickerCode()}`);
    const sameOriginStatus = await page.evaluate(async () => (await fetch('/cookie-picker/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domains: ['synthetic.test'] }),
    })).status);
    expect(sameOriginStatus).toBe(200);
    expect(removed).toBe(1);
    observed.length = 0;
    await page.goto(attackerOrigin);
    for (const action of ['import', 'remove']) {
      await page.evaluate(async ({ target, action }) => {
        await fetch(`${target}/cookie-picker/${action}`, { method: 'POST', mode: 'no-cors', credentials: 'include',
          headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ browser: 'Chromium', domains: ['synthetic.test'], clearStorage: true }) });
      }, { target: pickerOrigin, action });
    }
    expect(observed).toEqual([1, 2].map(() => ({ origin: attackerOrigin, cookiePresent: true, status: 403, contentType: 'text/plain' })));
    expect(removed).toBe(1);
  } finally {
    await browser?.close();
    picker.stop(true);
    attacker.stop(true);
    const now = Date.now;
    Date.now = () => now() + 3_600_001;
    try { hasActivePicker(); } finally { Date.now = now; }
  }
}, 40_000);
