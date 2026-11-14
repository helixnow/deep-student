import { generateKeyPairSync, sign } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2b';
import { expect, it } from 'vitest';
import { verifyMinisign } from '../shell/minisign.ts';

const key = 'untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3';
const encoded = (text: string) => Buffer.from(text).toString('base64');
it('minisign_verify::verify accepts the original Rust legacy signature vector', () => {
  const sig = 'untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==';
  expect(() => verifyMinisign(Buffer.from('test'), encoded(sig), encoded(key))).not.toThrow();
  expect(() => verifyMinisign(Buffer.from('changed'), encoded(sig), encoded(key))).toThrow('The signature verification failed');
});
it('prehashed signatures authenticate payload and trusted comment; mismatching key IDs reject first', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const id = Buffer.from('0102030405060708', 'hex');
  const rawKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const pub = encoded(`untrusted comment: public key\n${Buffer.concat([Buffer.from('Ed'), id, rawKey]).toString('base64')}`);
  const payload = Buffer.from('release');
  const signature = sign(null, blake2b(payload), privateKey);
  const comment = 'timestamp:123';
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
  const text = `untrusted comment: signature\n${Buffer.concat([Buffer.from('ED'), id, signature]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}`;
  expect(() => verifyMinisign(payload, encoded(text), pub)).not.toThrow();
  expect(() => verifyMinisign(payload, encoded(text.replace('timestamp:123', 'timestamp:124')), pub)).toThrow('The signature verification failed');
  const other = encoded(`untrusted comment: public key\n${Buffer.concat([Buffer.from('Ed'), Buffer.alloc(8), rawKey]).toString('base64')}`);
  expect(() => verifyMinisign(payload, encoded(text), other)).toThrow('The signature was created with a different key than the one provided');
});
