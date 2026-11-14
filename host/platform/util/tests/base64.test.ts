import { expect, it } from 'vitest';
import { decodeBase64Standard } from '../node.ts';
import { decodeBase64Standard as legacyExport } from '../../secrets/crypto-service.ts';

// base64 0.22.1 general_purpose::STANDARD (decode.rs DecodeError Display).
it('decodeBase64Standard is published from util with base64 0.22 DecodeError Display', () => {
  expect(legacyExport).toBe(decodeBase64Standard);
  expect(decodeBase64Standard('')).toEqual({ bytes: Buffer.alloc(0) });
  expect(decodeBase64Standard('aGVsbG8=')).toEqual({ bytes: Buffer.from('hello') });
  expect(decodeBase64Standard('aGk=')).toEqual({ bytes: Buffer.from('hi') });
  expect(decodeBase64Standard('!!!!')).toEqual({ error: 'Invalid symbol 33, offset 0.' });
  expect(decodeBase64Standard('a')).toEqual({ error: 'Invalid input length: 1' });
  expect(decodeBase64Standard('aGVsbG8')).toEqual({ error: 'Invalid padding' });
  expect(decodeBase64Standard('aGl=')).toEqual({ error: 'Invalid last symbol 108, offset 2.' });
});
