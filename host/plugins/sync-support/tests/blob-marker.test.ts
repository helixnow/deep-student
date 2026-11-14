import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { blobMarkerParam } from '../repository/records.ts';

it('$dsblob decoding matches Buffer for canonical, non-canonical-tail and rejected inputs', () => {
  for (let length = 0; length < 40; length++) {
    const bytes = randomBytes(length);
    const encoded = bytes.toString('base64');
    expect(blobMarkerParam({ $dsblob: encoded })).toEqual(new Uint8Array(bytes));
  }
  for (const encoded of ['QR==', 'QUJ=', 'AAAB']) {
    expect(blobMarkerParam({ $dsblob: encoded })).toEqual(new Uint8Array(Buffer.from(encoded, 'base64')));
  }
  for (const encoded of ['QQ', 'QQ=', 'Q-==', ' QQ==', 'QQ==QQ==']) expect(blobMarkerParam({ $dsblob: encoded })).toBeNull();
});
