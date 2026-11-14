/** Cloud-side E2EE marker (sync_manager.rs:162-174); camelCase serde wire shape. */

import type { PasswordVerifier } from '../../../platform/secrets/api.ts';
import {
  decodeOption,
  decodeString,
  decodeStruct,
  decodeU32,
  decodeUtcTimestamp,
  fromSlice,
  type Deserializer,
} from './serde_struct.ts';
import { utf8Encode } from './bytes.ts';

export interface EncryptionMarker {
  version: number;
  createdByDevice: string;
  createdAt: string;
  keyVerifier?: PasswordVerifier | null;
}

export type EncryptionMarkerState =
  | { kind: 'Absent' }
  | { kind: 'Present'; marker: EncryptionMarker; raw: Uint8Array }
  | { kind: 'Corrupted'; raw: Uint8Array | null };

/** `dstu-security` backup_crypto.rs:908-923 `PasswordVerifier` (camelCase, all fields required). */
function decodePasswordVerifier(input: Deserializer): PasswordVerifier {
  return decodeStruct(input, 'PasswordVerifier', {
    kdf: { decode: decodeString },
    mCost: { decode: decodeU32 },
    tCost: { decode: decodeU32 },
    pCost: { decode: decodeU32 },
    salt: { decode: decodeString },
    digest: { decode: decodeString },
  });
}

function decodeMarkerValue(input: Deserializer): EncryptionMarker {
  const fields = decodeStruct(input, 'EncryptionMarker', {
    version: { decode: decodeU32 },
    createdByDevice: { decode: decodeString },
    createdAt: { decode: (value: Deserializer) => decodeUtcTimestamp(value, 'createdAt') },
    keyVerifier: {
      decode: (value: Deserializer) => decodeOption(value, decodePasswordVerifier) ?? null,
      default: (): PasswordVerifier | null => null,
    },
  });
  return {
    version: fields.version,
    createdByDevice: fields.createdByDevice,
    createdAt: fields.createdAt,
    keyVerifier: fields.keyVerifier,
  };
}

/** `serde_json::from_slice::<PasswordVerifier>`; throws `SerdeJsonError`. */
export function decodePasswordVerifierBytes(data: Uint8Array): PasswordVerifier {
  return fromSlice(data, decodePasswordVerifier);
}

/** `PasswordVerifier` Serialize: struct declaration order, camelCase, all fields present. */
function passwordVerifierFields(verifier: PasswordVerifier): PasswordVerifier {
  return {
    kdf: verifier.kdf,
    mCost: verifier.mCost,
    tCost: verifier.tCost,
    pCost: verifier.pCost,
    salt: verifier.salt,
    digest: verifier.digest,
  };
}

/** `serde_json::to_vec(&PasswordVerifier)` (compact). */
export function encodePasswordVerifier(verifier: PasswordVerifier): Uint8Array {
  return utf8Encode(JSON.stringify(passwordVerifierFields(verifier)));
}

/** `serde_json::from_slice::<EncryptionMarker>`; throws `SerdeJsonError`. */
export function decodeEncryptionMarker(data: Uint8Array): EncryptionMarker {
  return fromSlice(data, decodeMarkerValue);
}

/** `serde_json::to_vec_pretty(&EncryptionMarker)`: declaration order, `None` verifier omitted. */
export function encodeEncryptionMarker(marker: EncryptionMarker): Uint8Array {
  const body: Record<string, unknown> = {
    version: marker.version,
    createdByDevice: marker.createdByDevice,
    createdAt: marker.createdAt,
  };
  const verifier = marker.keyVerifier;
  if (verifier != null) body.keyVerifier = passwordVerifierFields(verifier);
  return utf8Encode(JSON.stringify(body, null, 2));
}
