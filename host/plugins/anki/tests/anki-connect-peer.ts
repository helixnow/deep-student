/**
 * Deterministic AnkiConnect HTTP peer (WP-157).
 *
 * It replaces the external Anki desktop + AnkiConnect add-on, never the client under
 * test: production code keeps its own fetch / net probe against the hard-coded
 * `http://127.0.0.1:8765` (Rust `anki_connect_service.rs:10`, TS `src/anki-connect.ts:18`).
 * The peer only answers AnkiConnect actions the way the add-on does; it does not compute
 * any DeepStudent result (sync report, error text, version negotiation).
 *
 * Plain Node (`node:http`, erasable TS only) so the equivalence runner can import it with
 * `node --experimental-strip-types` as well as vitest.
 */
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** One raw HTTP request as received (before any interpretation). */
export interface AnkiConnectPeerRequest {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** `action` from the JSON body, `'GET'` for body-less probes, `null` when the body is not JSON. */
  readonly action: string | null;
}

/**
 * Scripted transport behaviour for one action.
 * - `reply`: send `status` (default 200) and the exact `body` bytes.
 * - `disconnect: 'before-headers'`: read the request, then close the socket without a response.
 * - `disconnect: 'mid-body'`: send headers with `Content-Length` larger than `body`, write `body`, close.
 */
export type AnkiConnectPeerFault =
  | { readonly kind: 'reply'; readonly status?: number; readonly body: string; readonly contentType?: string }
  | { readonly kind: 'disconnect'; readonly at: 'before-headers' | 'mid-body'; readonly body?: string };

export interface AnkiConnectPeerModel {
  readonly fields: readonly string[];
  readonly isCloze?: boolean;
  readonly templates?: unknown;
  readonly css?: string;
}

export interface AnkiConnectPeerProfile {
  /** Value answered for `version` (`result`). Default 6. */
  readonly version?: unknown;
  /** Existing decks, in Anki `deckNames` order. Default `['Default']`. */
  readonly decks?: readonly string[];
  /** Existing note types. Default: Anki stock `Basic` and `Cloze`. */
  readonly models?: Readonly<Record<string, AnkiConnectPeerModel>>;
  /** First note id handed out by add actions. Default 1_700_000_000_001. */
  readonly firstNoteId?: number;
  /** Notes that already exist: `"<modelName>\u0000<first field value>"` keys. */
  readonly existingNotes?: readonly string[];
  /**
   * Per-action scripted faults. A single fault applies to every request of that action;
   * an array is consumed in order, after which the action answers normally.
   * Key `'GET'` targets body-less probes.
   */
  readonly faults?: Readonly<Record<string, AnkiConnectPeerFault | readonly AnkiConnectPeerFault[]>>;
}

export interface AnkiConnectPeer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** Raw requests since the last reset, in arrival order. */
  readonly requests: readonly AnkiConnectPeerRequest[];
  /** TCP connections accepted since the last reset (includes bare port probes). */
  readonly connections: number;
  /** Replace state and faults with `profile`, clear recorded requests/connections. */
  reset(profile?: AnkiConnectPeerProfile): void;
  /** Close the listener and every open socket; resolves once the port is released. */
  stop(): Promise<void>;
}

export const ANKI_CONNECT_PEER_DEFAULT_HOST = '127.0.0.1';
export const ANKI_CONNECT_PEER_DEFAULT_PORT = 8765;

const STOCK_MODELS: Readonly<Record<string, AnkiConnectPeerModel>> = {
  Basic: {
    fields: ['Front', 'Back'],
    templates: { 'Card 1': { Front: '{{Front}}', Back: '{{FrontSide}}<hr id=answer>{{Back}}' } },
    css: '.card {}',
  },
  Cloze: {
    fields: ['Text', 'Back Extra'],
    isCloze: true,
    templates: { Cloze: { Front: '{{cloze:Text}}', Back: '{{cloze:Text}}<br>{{Back Extra}}' } },
    css: '.card {}',
  },
};

interface PeerState {
  version: unknown;
  decks: string[];
  models: Map<string, AnkiConnectPeerModel>;
  nextNoteId: number;
  notes: Set<string>;
  faults: Map<string, AnkiConnectPeerFault | AnkiConnectPeerFault[]>;
}

function freshState(profile: AnkiConnectPeerProfile = {}): PeerState {
  const faults = new Map<string, AnkiConnectPeerFault | AnkiConnectPeerFault[]>();
  for (const [action, fault] of Object.entries(profile.faults ?? {})) {
    faults.set(action, Array.isArray(fault) ? [...fault] : fault as AnkiConnectPeerFault);
  }
  return {
    version: profile.version === undefined ? 6 : profile.version,
    decks: [...(profile.decks ?? ['Default'])],
    models: new Map(Object.entries(profile.models ?? STOCK_MODELS)),
    nextNoteId: profile.firstNoteId ?? 1_700_000_000_001,
    notes: new Set(profile.existingNotes ?? []),
    faults,
  };
}

function takeFault(state: PeerState, action: string): AnkiConnectPeerFault | undefined {
  const entry = state.faults.get(action);
  if (entry === undefined) return undefined;
  if (!Array.isArray(entry)) return entry;
  const next = entry.shift();
  if (entry.length === 0) state.faults.delete(action);
  return next;
}

type Envelope = { result: unknown; error: string | null };
const ok = (result: unknown): Envelope => ({ result, error: null });
const fail = (error: string): Envelope => ({ result: null, error });

interface NoteParam {
  deckName?: unknown;
  modelName?: unknown;
  fields?: Record<string, unknown>;
}

/** Anki duplicate key: model + first field of that model (AnkiConnect `canAddNotes` / `addNote`). */
function noteKey(state: PeerState, note: NoteParam): string | null {
  if (typeof note.modelName !== 'string' || typeof note.deckName !== 'string') return null;
  const model = state.models.get(note.modelName);
  if (model === undefined || !state.decks.includes(note.deckName)) return null;
  const first = model.fields[0];
  const value = first === undefined ? undefined : note.fields?.[first];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return `${note.modelName}\u0000${value}`;
}

/** AnkiConnect v6 add-on semantics for the actions DeepStudent sends. */
function answer(state: PeerState, action: string, params: Record<string, unknown>): Envelope {
  switch (action) {
    case 'version':
      return ok(state.version);
    case 'deckNames':
      return ok([...state.decks]);
    case 'modelNames':
      return ok([...state.models.keys()]);
    case 'createDeck': {
      const deck = params.deck;
      if (typeof deck !== 'string') return fail('deck name must be a string');
      if (!state.decks.includes(deck)) state.decks.push(deck);
      return ok(1_000_000 + state.decks.indexOf(deck));
    }
    case 'modelFieldNames': {
      const model = typeof params.modelName === 'string' ? state.models.get(params.modelName) : undefined;
      return model === undefined ? fail(`model was not found: ${String(params.modelName)}`) : ok([...model.fields]);
    }
    case 'modelTemplates':
    case 'modelStyling': {
      const model = typeof params.modelName === 'string' ? state.models.get(params.modelName) : undefined;
      if (model === undefined) return fail(`model was not found: ${String(params.modelName)}`);
      return ok(action === 'modelTemplates' ? model.templates ?? {} : { css: model.css ?? '' });
    }
    case 'createModel': {
      const name = params.modelName;
      if (typeof name !== 'string') return fail('modelName must be a string');
      if (state.models.has(name)) return fail(`Model name already exists`);
      const fields = Array.isArray(params.inOrderFields) ? params.inOrderFields.map(String) : [];
      state.models.set(name, { fields, isCloze: params.isCloze === true, css: String(params.css ?? '') });
      return ok({ name });
    }
    case 'canAddNotes': {
      const notes = Array.isArray(params.notes) ? params.notes as NoteParam[] : [];
      return ok(notes.map((note) => {
        const key = noteKey(state, note);
        return key !== null && !state.notes.has(key);
      }));
    }
    case 'addNotes': {
      const notes = Array.isArray(params.notes) ? params.notes as NoteParam[] : [];
      return ok(notes.map((note) => {
        const key = noteKey(state, note);
        if (key === null || state.notes.has(key)) return null;
        state.notes.add(key);
        return state.nextNoteId++;
      }));
    }
    case 'addNote': {
      const note = (params.note ?? {}) as NoteParam;
      const key = noteKey(state, note);
      if (key === null) return fail('cannot create note because it is empty');
      if (state.notes.has(key)) return fail('cannot create note because it is a duplicate');
      state.notes.add(key);
      return ok(state.nextNoteId++);
    }
    case 'storeMediaFile':
      return typeof params.filename === 'string' ? ok(params.filename) : fail('filename must be a string');
    default:
      return fail('unsupported action');
  }
}

function writeFault(socket: Socket, response: http.ServerResponse, fault: AnkiConnectPeerFault): void {
  if (fault.kind === 'reply') {
    const body = Buffer.from(fault.body, 'utf8');
    response.writeHead(fault.status ?? 200, {
      'Content-Type': fault.contentType ?? 'application/json',
      'Content-Length': String(body.length),
    });
    response.end(body);
    return;
  }
  if (fault.at === 'before-headers') {
    socket.destroy();
    return;
  }
  const body = Buffer.from(fault.body ?? '{"result":', 'utf8');
  response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(body.length + 64) });
  response.flushHeaders();
  response.write(body, () => socket.end());
}

/**
 * Bind the peer. Defaults to the AnkiConnect production address. If the port is already
 * taken the promise rejects (`EADDRINUSE`); the peer never stops or replaces another process.
 */
export async function startAnkiConnectPeer(options: {
  readonly host?: string;
  readonly port?: number;
  readonly profile?: AnkiConnectPeerProfile;
} = {}): Promise<AnkiConnectPeer> {
  const host = options.host ?? ANKI_CONNECT_PEER_DEFAULT_HOST;
  let state = freshState(options.profile);
  let requests: AnkiConnectPeerRequest[] = [];
  let connections = 0;
  const sockets = new Set<Socket>();

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed: { action?: unknown; params?: unknown } | null = null;
      if (body !== '') {
        try {
          parsed = JSON.parse(body) as { action?: unknown; params?: unknown };
        } catch {
          parsed = null;
        }
      }
      const action = body === '' ? 'GET' : typeof parsed?.action === 'string' ? parsed.action : null;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
      requests.push({ seq: requests.length, method: request.method ?? '', path: request.url ?? '', headers, body, action });

      const fault = action === null ? undefined : takeFault(state, action);
      if (fault !== undefined) {
        writeFault(request.socket, response, fault);
        return;
      }
      // AnkiConnect answers a body-less GET with a plain banner.
      if (action === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end(`AnkiConnect v.${String(state.version)}`);
        return;
      }
      const envelope = action === null
        ? fail('request body is not a JSON AnkiConnect request')
        : answer(state, action, (parsed?.params ?? {}) as Record<string, unknown>);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(envelope));
    });
  });
  server.on('connection', (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? ANKI_CONNECT_PEER_DEFAULT_PORT, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    host,
    port,
    url: `http://${host}:${port}`,
    get requests() { return requests; },
    get connections() { return connections; },
    reset(profile) {
      state = freshState(profile);
      requests = [];
      connections = 0;
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
