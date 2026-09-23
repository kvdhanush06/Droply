import { describe, expect, it } from 'vitest';
import { createHash, createHmac, pbkdf2Sync, webcrypto } from 'node:crypto';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  aesExpandKey,
  hmacSha256,
  pbkdf2Sha256,
  sha256,
  timingSafeEqual,
} from '../src/services/transfer/jsCrypto';
import {
  computeAuthProof,
  createAuthChallenge,
  decryptChunk,
  deriveSenderKey,
  encryptChunk,
  verifyAuthProof,
} from '../src/services/transfer/crypto';
import { hex } from './helpers';

describe('pure-JS SHA-256', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hex(sha256(new TextEncoder().encode('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches node:crypto across many sizes (padding, multi-block, chunked input)', () => {
    for (const size of [1, 55, 56, 57, 63, 64, 65, 127, 128, 1000, 4096]) {
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) data[i] = (i * 7 + 3) & 0xff;
      const expected = createHash('sha256').update(data).digest('hex');
      expect(hex(sha256(data))).toBe(expected);
      // Chunked input must equal the same digest.
      const half = Math.floor(size / 2);
      expect(hex(sha256(data.slice(0, half), data.slice(half)))).toBe(expected);
    }
  });
});

describe('pure-JS HMAC-SHA256', () => {
  it('matches RFC 4231 test case 2', () => {
    const key = new TextEncoder().encode('Jefe');
    const data = new TextEncoder().encode('what do ya want for nothing?');
    expect(hex(hmacSha256(key, data))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('matches node:crypto for short, boundary and long keys', () => {
    const data = new TextEncoder().encode('payload');
    for (const keyLength of [0, 1, 32, 63, 64, 65, 100, 200]) {
      const key = new Uint8Array(keyLength).fill(0x5a);
      const expected = createHmac('sha256', key).update(data).digest('hex');
      expect(hex(hmacSha256(key, data))).toBe(expected);
    }
  });
});

describe('pure-JS PBKDF2-HMAC-SHA256', () => {
  it('matches RFC 7914 §11 test vector', () => {
    // PBKDF2-HMAC-SHA-256(P="passwd", S="salt", c=1, dkLen=64)
    const pw = new TextEncoder().encode('passwd');
    const salt = new TextEncoder().encode('salt');
    expect(hex(pbkdf2Sha256(pw, salt, 1, 64))).toBe(
      '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783',
    );
  });

  it('matches node:crypto for multi-block output and various round counts', () => {
    const pw = new TextEncoder().encode('hunter2');
    const salt = new TextEncoder().encode('droply-salt');
    for (const [iterations, length] of [
      [1, 32],
      [2, 48],
      [10, 64],
      [1000, 48],
    ] as const) {
      const expected = pbkdf2Sync(pw, salt, iterations, length, 'sha256').toString('hex');
      expect(hex(pbkdf2Sha256(pw, salt, iterations, length))).toBe(expected);
    }
  });
});

describe('pure-JS AES-256-GCM', () => {
  // Node's WebCrypto is the oracle: our fallback must produce byte-identical
  // sealed output (IV||ciphertext||tag) for the same key/IV/plaintext.
  it('is byte-identical to node:crypto WebCrypto for a known input', async () => {
    const rawKey = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) rawKey[i] = i;
    const iv = new Uint8Array(12).fill(0xab);
    const plain = new TextEncoder().encode('Droply fallback parity check');

    const webKey = await webcrypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const expected = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, webKey, plain));

    const key = aesExpandKey(rawKey);
    expect(hex(aesGcmEncrypt(key, iv, plain))).toBe(hex(expected));
    expect(hex(aesGcmDecrypt(key, iv, expected)!)).toBe(hex(plain));
  });

  it('round-trips plaintext at multiple sizes (aligned, partial, empty)', () => {
    const keyBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) keyBytes[i] = i;
    const key = aesExpandKey(keyBytes);
    const iv = new Uint8Array(12).fill(0xab);
    for (const size of [0, 1, 15, 16, 17, 33, 512, 4096]) {
      const plain = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) plain[i] = (i * 31 + 5) & 0xff;
      const sealed = aesGcmEncrypt(key, iv, plain);
      expect(sealed.length).toBe(size + 16);
      const opened = aesGcmDecrypt(key, iv, sealed);
      expect(opened).not.toBeNull();
      expect(hex(opened!)).toBe(hex(plain));
    }
  });

  it('rejects tampered ciphertext and wrong keys', () => {
    const keyBytes = new Uint8Array(32).fill(3);
    const key = aesExpandKey(keyBytes);
    const iv = new Uint8Array(12).fill(9);
    const plain = new TextEncoder().encode('attack at dawn');
    const sealed = aesGcmEncrypt(key, iv, plain);
    sealed[0]! ^= 1;
    expect(aesGcmDecrypt(key, iv, sealed)).toBeNull();

    sealed[0]! ^= 1; // restore
    const otherKey = aesExpandKey(new Uint8Array(32).fill(4));
    expect(aesGcmDecrypt(otherKey, iv, sealed)).toBeNull();
  });
});

describe('crypto facade (WebCrypto or fallback)', () => {
  it('derives matching verifier material on both sides', async () => {
    const salt = new Uint8Array(16).fill(0x42);
    const receiver = await createAuthChallenge('shared-password');
    const senderProof = await computeAuthProof('shared-password', salt, receiver.challenge.iterations);
    const receiverVerifier = await computeAuthProof('shared-password', salt, receiver.challenge.iterations);
    expect(hex(receiverVerifier)).toBe(hex(senderProof));
    expect(verifyAuthProof(senderProof, receiver.expectedProof)).toBe(false); // different salt
    expect(verifyAuthProof(senderProof, receiverVerifier)).toBe(true);
  }, 30000);

  it('encrypts chunks with the derived key and decrypts them', async () => {
    const salt = new Uint8Array(16).fill(0x11);
    const key = await deriveSenderKey('round-trip', salt, 1000);
    const payload = new Uint8Array(1000);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i & 0xff;
    const sealed = await encryptChunk(key, payload.buffer as ArrayBuffer);
    expect(sealed.byteLength).toBe(payload.length + 12 + 16);
    const opened = await decryptChunk(key, sealed);
    expect(opened).not.toBeNull();
    expect(hex(new Uint8Array(opened!))).toBe(hex(payload));
  }, 30000);

  it('fails decryption with the wrong password', async () => {
    const salt = new Uint8Array(16).fill(0x33);
    const goodKey = await deriveSenderKey('right', salt, 1000);
    const badKey = await deriveSenderKey('wrong', salt, 1000);
    const payload = new Uint8Array(64).fill(1);
    const sealed = await encryptChunk(goodKey, payload.buffer as ArrayBuffer);
    expect(await decryptChunk(badKey, sealed)).toBeNull();
  }, 30000);
});

describe('timingSafeEqual', () => {
  it('compares content, not length tricks', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
