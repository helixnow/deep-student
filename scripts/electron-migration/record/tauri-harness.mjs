// Executed inside the actual Tauri main webview, never in a synthetic Rust host.
// WP-043 intentionally admits only get_app_version({}); broader numeric argument
// transport and event-eval precision need independent raw-wire evidence.
const originalFetch = window.fetch.bind(window);
const wire = [];
const events = [];
const post = (path, body) => originalFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
window.fetch = async (url, options) => {
  const response = await originalFetch(url, options);
  if (String(url).startsWith('ipc:') || /^https?:\/\/ipc\.localhost\//.test(String(url))) {
    // Read the clone BEFORE Tauri's response.json() callback. The response body
    // string, not the renderer's parsed projection, is the numeric authority.
    wire.push({ url: String(url), requestRaw: options.body, status: response.status,
      kind: response.headers.get('Tauri-Response'), contentType: response.headers.get('content-type'),
      responseRaw: await response.clone().text() });
  }
  return response;
};

try {
  if (typeof window.__TAURI_INTERNALS__?.invoke !== 'function') throw new Error('real Tauri invoke unavailable');
  // This removes only the product's blank-page watchdog for the deliberately
  // minimal harness, not its IPC registry or command implementation.
  window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__?.();
  await post('/ready', { backend: 'tauri', href: location.href });
  for (;;) {
    const next = await (await originalFetch('/next')).json();
    if (next.close) {
      // process::exit runs the native exit path so LLVM can flush profraw.
      await post('/closing', { wire, events });
      await window.__TAURI_INTERNALS__.invoke('plugin:process|exit', { code: 0 });
      break;
    }
    if (next.command !== 'get_app_version' || next.argsRaw !== '{}') throw new Error('WP-043 harness accepts only get_app_version({})');
    const start = wire.length;
    let projection;
    try { projection = { kind: 'result', value: await window.__TAURI_INTERNALS__.invoke(next.command, JSON.parse(next.argsRaw)) }; }
    catch (error) { projection = { kind: 'error', error }; }
    const records = wire.slice(start);
    if (records.length !== 1) throw new Error('raw custom-protocol response missing; postMessage fallback is not precision evidence');
    const response = records[0];
    if (!response.contentType?.startsWith('application/json')) throw new Error('non-JSON IPC response requires a separate byte codec');
    if (!['ok', 'error'].includes(response.kind)) throw new Error('missing Tauri-Response outcome');
    await post('/outcome', { kind: response.kind === 'ok' ? 'result' : 'error', raw: response.responseRaw,
      projection, wire: records, events, eventScope: 'get_app_version has no event emission; no global event subscription' });
  }
} catch (error) {
  await post('/failure', { message: String(error?.stack ?? error), wire, events });
}
