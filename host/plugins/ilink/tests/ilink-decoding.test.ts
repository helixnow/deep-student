import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { IlinkClient, emptyCredentials } from '../api.ts';

it('F1-V2-02 get_updates decodes exact Rust integer widths and serde default Vec', async () => {
  // client.rs:46-83: i64 ret/errcode, u64 IDs/time, i32 discriminants,
  // #[serde(default)] Vec accepts missing, but not null. Exercise the real HTTP entry.
  let body = '{}';
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const creds = { ...emptyCredentials(), token: 't', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const client = new IlinkClient();
  try {
    expect((await client.getUpdates(creds, 1)).msgs).toEqual([]);
    body = '{"ret":-9223372036854775808,"msgs":[{"seq":9007199254740993,"message_id":18446744073709551615,"create_time_ms":9007199254740995}]}';
    const result = await client.getUpdates(creds, 1);
    expect(result.ret).toBe(-9223372036854775808n);
    expect(result.msgs[0]).toMatchObject({ seq: 9007199254740993n, message_id: 18446744073709551615n, create_time_ms: 9007199254740995n, item_list: [] });
    for (const invalid of [
      '{"msgs":null}', '{"msgs":[{"item_list":null}]}',
      '{"msgs":[{"seq":18446744073709551616}]}', '{"ret":9223372036854775808}',
      '{"msgs":[{"message_type":2147483648}]}', '{"msgs":[{"seq":1.0}]}',
      '{"msgs":[{"seq":1e0}]}', '{"msgs":[{"seq":-1}]}',
    ]) {
      body = invalid;
      await expect(client.getUpdates(creds, 1), invalid).rejects.toMatchObject({ error_type: 'Validation' });
    }
    body = '{"ret":null,"msgs":[{"seq":null,"item_list":[],"unknown":true}]}';
    expect((await client.getUpdates(creds, 1)).msgs[0]?.seq).toBeNull();
    body = '{"msgs":[],"msgs":[]}';
    await expect(client.getUpdates(creds, 1)).rejects.toMatchObject({
      message: '解析 getupdates 失败: error decoding response body: duplicate field `msgs` at line 1 column 17',
    });
    body = '{"msgs":null}';
    await expect(client.getUpdates(creds, 1)).rejects.toMatchObject({
      message: '解析 getupdates 失败: error decoding response body: invalid type: null, expected a sequence at line 1 column 12',
    });
    // client.rs:323-334 Value::as_i64 ignores floats/out-of-range integers,
    // while its returned JSON and business-error Display preserve the original integers.
    body = '{"ret":1.0,"id":9007199254740993}';
    await expect(client.sendText(creds, 'p', 'ctx', 'hi')).resolves.toEqual({ ret: 1, id: 9007199254740993n });
    body = '{"ret":9223372036854775808}';
    await expect(client.sendText(creds, 'p', 'ctx', 'hi')).resolves.toEqual({ ret: 9223372036854775808n });
    body = '{ "ret": 9007199254740993, "message": "失败" }';
    await expect(client.sendText(creds, 'p', 'ctx', 'hi')).rejects.toEqual({
      error_type: 'Network', details: null,
      message: 'sendmessage 业务错误: {"ret":9007199254740993,"message":"失败"}',
    });
    for (const [input, detail] of [
      ['{broken', 'key must be a string at line 1 column 2'],
      ['{"msgs":[]', 'EOF while parsing an object at line 1 column 10'],
      ['{"msgs":[],}', 'trailing comma at line 1 column 12'],
      ['{"msgs":[}', 'expected value at line 1 column 10'],
      ['{"errmsg":"\\uD800"}', 'unexpected end of hex escape at line 1 column 18'],
    ]) {
      body = input!;
      await expect(client.getUpdates(creds, 1)).rejects.toMatchObject({
        message: `解析 getupdates 失败: error decoding response body: ${detail}`,
      });
    }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
