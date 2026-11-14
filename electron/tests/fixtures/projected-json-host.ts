/** F2 protocol fixture: ordinary typed numbers without any raw-source metadata. */
interface Port {
  on(event: 'message', listener: (event: { data: Record<string, unknown> }) => void): void;
  postMessage(message: unknown): void;
  start(): void;
}
const parentPort = (process as unknown as { parentPort: { on(event: 'message', listener: (event: { ports: Port[] }) => void): void } }).parentPort;
const payload: unknown = JSON.parse('{"numbers":[1e400,-1e400,-1e-400,-0,0,1.5],"ordinary":{"rawJSON":"1e400"}}');
parentPort.on('message', ({ ports }) => {
  const port = ports[0]!;
  port.on('message', ({ data }) => {
    if (data.kind === 'handshake') port.postMessage({ kind: 'ready', protocol: 1 });
    if (data.kind === 'invoke') {
      port.postMessage({ kind: 'result', id: data.id, ok: true, value: payload });
      port.postMessage({ kind: 'event', event: 'projected://numbers', target: { kind: 'Any' }, payload });
    }
    if (data.kind === 'shutdown') process.exit(0);
  });
  port.start();
});
