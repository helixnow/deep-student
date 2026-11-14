/** Local HTTP test server used by ASR/voice-input transport tests. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface TestServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startServer(
  respond: (request: RecordedRequest, response: ServerResponse) => void,
): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    const recorded: RecordedRequest = {
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(recorded);
    respond(recorded, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined ? resolve() : reject(error)));
    }),
  };
}

export function jsonResponder(
  body: unknown,
  status = 200,
): (request: RecordedRequest, response: ServerResponse) => void {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}
