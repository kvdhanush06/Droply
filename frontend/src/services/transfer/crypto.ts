import {
  KEY_BYTES,
  NONCE_BYTES,
  PBKDF2_ITERATIONS,
  SALT_BYTES,
} from './protocol';
import {
  aesExpandKey,
  aesGcmDecrypt as jsGcmDecrypt,
  aesGcmEncrypt as jsGcmEncrypt,
  pbkdf2Sha256,
  timingSafeEqual as jsTimingSafeEqual,
} from './jsCrypto';
import { pbkdf2InWorker } from './heavyTasks';

/**
 * Password-protected transfers
 * ----------------------------
 * The password never crosses the wire and the server never sees it. Both
 * sides derive 48 bytes from the password with PBKDF2-SHA256: 32 bytes are
 * the AES-GCM content key, 16 bytes are a verifier. The receiver sends the
 * random salt as an open challenge; the sender must return the verifier — a
 * value from which neither the key nor the password can be reconstructed.
 * File chunks are then encrypted with the AES-GCM key, so captured
 * DataChannel traffic is useless without the password.
 *
 * WebCrypto (`crypto.subtle`) is used wherever the browser exposes it.
 * Plain-HTTP LAN origins (e.g. http://192.168.x.x:5000) run in an insecure
 * context where WebCrypto is disabled entirely — previously the password
 * handshake silently failed there with "Could not start the password
 * check". Those environments now transparently fall back to the audited
 * pure-JS implementation in `jsCrypto.ts` with identical wire output.
 */

/** Opaque symmetric key usable by either crypto backend. */
export interface AesKey {
  readonly subtle: CryptoKey | null;
  readonly raw: Uint32Array | null;
  readonly insecure: boolean;
}

function subtleAvailable(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle === 'object' &&
    crypto.subtle !== null &&
    typeof crypto.subtle.deriveBits === 'function'
  );
}

const encoder = new TextEncoder();

/** WebCrypto path: derive key material and build the extractable-off AES key. */
async function deriveMaterialSubtle(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<{ key: AesKey; verifier: Uint8Array }> {
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
      baseKey,
      (KEY_BYTES + NONCE_BYTES) * 8,
    ),
  );
  const keyMaterial = bits.slice(0, KEY_BYTES);
  const verifier = bits.slice(KEY_BYTES);
  const key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  return { key: { subtle: key, raw: null, insecure: false }, verifier };
}

/** Pure-JS path: same derivation, same wire format, no WebCrypto needed. */
function deriveMaterialJsSync(
  password: string,
  salt: Uint8Array,
  iterations: number,
): { key: AesKey; verifier: Uint8Array } {
  const bits = pbkdf2Sha256(encoder.encode(password), salt, iterations, KEY_BYTES + NONCE_BYTES);
  const keyMaterial = bits.slice(0, KEY_BYTES);
  const verifier = bits.slice(KEY_BYTES);
  const raw = aesExpandKey(keyMaterial);
  return { key: { subtle: null, raw, insecure: true }, verifier };
}

/**
 * Pure-JS derivation, preferring the transfer worker: 250k PBKDF2 rounds
 * take seconds on a phone, and running them on the main thread freezes the
 * whole page. In the worker the page stays fully interactive — the password
 * dialog closes instantly and the “checking password” state shows while the
 * handshake completes.
 */
async function deriveMaterialJs(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<{ key: AesKey; verifier: Uint8Array }> {
  const workerBits = await pbkdf2InWorker(password, salt, iterations, KEY_BYTES + NONCE_BYTES);
  if (workerBits) {
    const keyMaterial = workerBits.slice(0, KEY_BYTES);
    const verifier = workerBits.slice(KEY_BYTES);
    const raw = aesExpandKey(keyMaterial);
    return { key: { subtle: null, raw, insecure: true }, verifier };
  }
  return deriveMaterialJsSync(password, salt, iterations);
}

async function deriveMaterial(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<{ key: AesKey; verifier: Uint8Array }> {
  if (subtleAvailable()) {
    try {
      return await deriveMaterialSubtle(password, salt, iterations);
    } catch {
      /* fall through to the pure-JS path */
    }
  }
  return deriveMaterialJs(password, salt, iterations);
}

/** Receiver side: build a fresh challenge for a batch. */
export async function createAuthChallenge(password: string): Promise<{
  challenge: { salt: Uint8Array; iterations: number };
  expectedProof: Uint8Array;
  key: AesKey;
}> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const { key, verifier } = await deriveMaterial(password, salt, PBKDF2_ITERATIONS);
  return { challenge: { salt, iterations: PBKDF2_ITERATIONS }, expectedProof: verifier, key };
}

/** Receiver side: check a sender's proof against the expected verifier. */
export function verifyAuthProof(proof: Uint8Array, expectedProof: Uint8Array): boolean {
  return jsTimingSafeEqual(proof, expectedProof);
}

/** Sender side: derive the verifier the receiver expects. */
export async function computeAuthProof(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const { verifier } = await deriveMaterial(password, salt, iterations);
  return verifier;
}

/** Sender side: derive the chunk-encryption key after the handshake. */
export async function deriveSenderKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<AesKey> {
  const { key } = await deriveMaterial(password, salt, iterations);
  return key;
}

/** AES-GCM encrypt one chunk with a random IV; returns IV||ciphertext||tag. */
export async function encryptChunk(key: AesKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  if (!key.insecure && key.subtle) {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key.subtle, data);
    const out = new Uint8Array(iv.length + ciphertext.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ciphertext), iv.length);
    return out.buffer;
  }
  if (!key.raw) throw new Error('Key material unavailable.');
  const sealed = jsGcmEncrypt(key.raw, iv, new Uint8Array(data));
  const out = new Uint8Array(sealed.length + 12);
  out.set(iv, 0);
  out.set(sealed, 12);
  return out.buffer;
}

/** AES-GCM decrypt one chunk; returns null when authentication fails. */
export async function decryptChunk(key: AesKey, frame: ArrayBuffer): Promise<ArrayBuffer | null> {
  if (frame.byteLength < 12 + 16) return null;
  const iv = new Uint8Array(frame, 0, 12);
  const payload = new Uint8Array(frame, 12);
  if (!key.insecure && key.subtle) {
    try {
      return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key.subtle, payload);
    } catch {
      return null;
    }
  }
  if (!key.raw) return null;
  const plain = jsGcmDecrypt(key.raw, iv, payload);
  if (plain === null) return null;
  return plain.slice().buffer as ArrayBuffer;
}

export { PBKDF2_ITERATIONS };
