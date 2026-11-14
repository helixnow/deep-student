// G3 page executed inside the real Tauri main webview (devUrl). It replaces the product
// frontend only; IPC registry, commands and events are the real Rust app's.
// Every invoke's custom-protocol request body and response body are captured verbatim;
// the node side rejects the step if the request body is not byte-identical to argsRaw.
const originalFetch = window.fetch.bind(window);
const internals = window.__TAURI_INTERNALS__;
const wire = [];
const pending = new Set();
let sequence = 0;
const post = (path, body) => originalFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ipcCommand = url => {
  const text = String(url);
  if (!text.startsWith('ipc:') && !/^https?:\/\/ipc\.localhost\//.test(text)) return null;
  return decodeURIComponent(new URL(text).pathname.slice(1));
};
window.fetch = async (url, options) => {
  const response = await originalFetch(url, options);
  const command = ipcCommand(url);
  if (command !== null) {
    wire.push({ url: String(url), command, requestRaw: typeof options?.body === 'string' ? options.body : null,
      requestType: typeof options?.body === 'string' ? 'string' : Object.prototype.toString.call(options?.body),
      status: response.status, kind: response.headers.get('Tauri-Response'), contentType: response.headers.get('content-type'),
      responseRaw: await response.clone().text() });
  }
  return response;
};
const onEvent = name => event => {
  // Tauri delivers event payloads as an evaluated JS literal (tauri 2.11.5 event/mod.rs
  // emit_js_script); the serialized text is not observable, so this is the parsed value.
  const body = { seq: sequence++, event: name, emitted: event.event, payloadRaw: JSON.stringify(event.payload ?? null) };
  const request = post('/event', body);
  pending.add(request);
  request.finally(() => pending.delete(request));
};

try {
  if (typeof internals?.invoke !== 'function' || typeof internals.transformCallback !== 'function') throw new Error('real Tauri invoke unavailable');
  window.__DSTU_BOOT_DIAGNOSTICS_CLEANUP__?.();
  await post('/ready', { backend: 'tauri', href: location.href });
  for (;;) {
    const next = await (await originalFetch('/next')).json();
    if (next.close) {
      await Promise.all(pending);
      await post('/closing', { wire: wire.length });
      // process::exit runs the native exit path so LLVM can flush profraw.
      await internals.invoke('plugin:process|exit', { code: 0 });
      break;
    }
    if (next.listen) {
      for (const name of next.listen) {
        await internals.invoke('plugin:event|listen', { event: name, target: { kind: 'Any' }, handler: internals.transformCallback(onEvent(name)) });
      }
      await post('/outcome', { listened: next.listen.length });
      continue;
    }
    const start = wire.length;
    let projection;
    try { projection = { kind: 'result', value: await internals.invoke(next.command, JSON.parse(next.argsRaw)) }; }
    catch (error) { projection = { kind: 'error', error }; }
    await Promise.all(pending);
    const records = wire.slice(start).filter(record => record.command === next.command);
    if (records.length !== 1) throw new Error(`${next.command}: expected one raw custom-protocol exchange, saw ${records.length}`);
    const [response] = records;
    if (!response.contentType?.startsWith('application/json')) throw new Error(`${next.command}: non-JSON IPC response (${response.contentType}) needs a byte codec`);
    if (!['ok', 'error'].includes(response.kind)) throw new Error(`${next.command}: missing Tauri-Response outcome`);
    let projected;
    try { projected = JSON.stringify(projection); } catch { projected = null; }
    await post('/outcome', { kind: response.kind === 'ok' ? 'result' : 'error', raw: response.responseRaw, requestRaw: response.requestRaw,
      requestType: response.requestType, projection: projected, wire: records });
  }
} catch (error) {
  await post('/failure', { message: String(error?.stack ?? error) });
}
