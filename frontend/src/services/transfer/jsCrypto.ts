/**
 * Pure-JS cryptographic primitives — a WebCrypto-compatible fallback used
 * only when `crypto.subtle` is unavailable (insecure HTTP origins such as a
 * plain LAN address, where browsers disable WebCrypto entirely).
 *
 * Implemented here:
 *  - SHA-256 (FIPS 180-4)
 *  - HMAC-SHA256 (RFC 2104)
 *  - PBKDF2-HMAC-SHA256 (RFC 8018)
 *  - AES-256-GCM (NIST SP 800-38D) with constant-time GHASH
 *
 * Every multi-byte integer is big-endian; function names map 1:1 onto the
 * WebCrypto operations they substitute so the crypto façade in `crypto.ts`
 * stays the single API surface for the rest of the app.
 */

/* ------------------------------------------------------------------ */
/* SHA-256                                                            */
/* ------------------------------------------------------------------ */

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Computes the SHA-256 digest of the concatenated input chunks. */
export function sha256(...chunks: Uint8Array[]): Uint8Array {
  const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
  const bitLength = totalBytes * 8;
  const bitLenHi = Math.floor(bitLength / 4294967296) >>> 0;
  const bitLenLo = bitLength >>> 0;

  const withLen = totalBytes + 9;
  const padded = new Uint8Array(Math.ceil(withLen / 64) * 64);
  let cursor = 0;
  for (const chunk of chunks) {
    padded.set(chunk, cursor);
    cursor += chunk.length;
  }
  padded[cursor] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLenHi);
  view.setUint32(padded.length - 4, bitLenLo);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i]! + w[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + hh) | 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i]! >>> 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* HMAC-SHA256                                                        */
/* ------------------------------------------------------------------ */

/** HMAC-SHA256 over `data` with `key` (RFC 2104). */
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  let keyMaterial = key;
  if (keyMaterial.length > 64) keyMaterial = sha256(keyMaterial);
  const padded = new Uint8Array(64);
  padded.set(keyMaterial);

  const ipad = new Uint8Array(64 + data.length);
  const opad = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i += 1) {
    ipad[i] = padded[i]! ^ 0x36;
    opad[i] = padded[i]! ^ 0x5c;
  }
  ipad.set(data, 64);
  opad.set(sha256(ipad), 64);
  return sha256(opad);
}

/* ------------------------------------------------------------------ */
/* PBKDF2-HMAC-SHA256                                                 */
/* ------------------------------------------------------------------ */

/**
 * PBKDF2-HMAC-SHA256 with constant-memory streaming. `password` is raw
 * password bytes. Runs synchronously: at 250k rounds this is roughly
 * 150-400 ms in a modern browser, executed only a handful of times per
 * protected transfer (once per handshake attempt per side).
 */
export function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  outputBytes: number,
): Uint8Array {
  if (iterations < 1) throw new Error('PBKDF2 requires at least one iteration.');
  // HMAC key material: the password itself, hashed only when longer than the
  // 64-byte block size (RFC 2104 key handling — same as hmacSha256 above).
  const key = password.length > 64 ? sha256(password) : password;
  const ipadKey = new Uint8Array(64);
  const opadKey = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    ipadKey[i] = (key[i] ?? 0) ^ 0x36;
    opadKey[i] = (key[i] ?? 0) ^ 0x5c;
  }

  const blocks = Math.ceil(outputBytes / 32);
  const out = new Uint8Array(blocks * 32);

  for (let blockIndex = 1; blockIndex <= blocks; blockIndex += 1) {
    // U1 = PRF(P, S || INT(i)) — salt plus the big-endian block index.
    const saltBlock = new Uint8Array(salt.length + 4);
    saltBlock.set(salt, 0);
    new DataView(saltBlock.buffer).setUint32(salt.length, blockIndex);
    // HMAC(P, m) with K = SHA-256(P) zero-padded to the block size:
    //   inner = SHA-256((K ⊕ ipad) || m)
    //   out   = SHA-256((K ⊕ opad) || inner)   ← plain hash, not HMAC again
    let u = sha256(opadKey, sha256(ipadKey, saltBlock));
    const blockOut = u.slice();
    for (let iter = 1; iter < iterations; iter += 1) {
      u = sha256(opadKey, sha256(ipadKey, u));
      for (let i = 0; i < 32; i += 1) blockOut[i] = blockOut[i]! ^ u[i]!;
    }
    out.set(blockOut, (blockIndex - 1) * 32);
  }
  return out.slice(0, outputBytes);
}

/* ------------------------------------------------------------------ */
/* AES-256 core (encrypt-only block primitive, used by GCM)           */
/* ------------------------------------------------------------------ */

const SBOX = new Uint8Array(256);
(() => {
  // Standard AES S-box generated at module load (no hand-typed table).
  const mul = (a: number, b: number): number => {
    let p = 0;
    let x = a;
    let y = b;
    while (y > 0) {
      if (y & 1) p ^= x;
      const hi = x & 0x80;
      x = (x << 1) & 0xff;
      if (hi) x ^= 0x1b;
      y >>= 1;
    }
    return p;
  };
  const pow = (base: number, exp: number): number => {
    let result = 1;
    let value = base;
    let e = exp;
    while (e > 0) {
      if (e & 1) result = mul(result, value);
      value = mul(value, value);
      e >>= 1;
    }
    return result;
  };
  const inverse = new Uint8Array(256);
  for (let i = 1; i < 256; i += 1) inverse[i] = pow(i, 254); // 254 = order-1
  inverse[0] = 0;
  for (let i = 0; i < 256; i += 1) {
    const s = inverse[i]!;
    const rot = (x: number, n: number): number => ((x << n) | (x >>> (8 - n))) & 0xff;
    SBOX[i] = s ^ rot(s, 1) ^ rot(s, 2) ^ rot(s, 3) ^ rot(s, 4) ^ 0x63;
  }
})();

/** Expands a 32-byte AES-256 key into the 60-word round-key schedule. */
export function aesExpandKey(key: Uint8Array): Uint32Array {
  if (key.length !== 32) throw new Error('AES-256 requires a 32-byte key.');
  const Nk = 8;
  const Nr = 14;
  const words = new Uint32Array(4 * (Nr + 1));
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  for (let i = 0; i < Nk; i += 1) words[i] = view.getUint32(i * 4);
  let rcon = 1;
  for (let i = Nk; i < words.length; i += 1) {
    let temp = words[i - 1]!;
    if (i % Nk === 0) {
      temp =
        ((SBOX[(temp >>> 16) & 0xff]! << 24) |
          (SBOX[(temp >>> 8) & 0xff]! << 16) |
          (SBOX[temp & 0xff]! << 8) |
          SBOX[(temp >>> 24) & 0xff]!) ^
        (rcon << 24);
      rcon = (rcon << 1) ^ ((rcon >> 7) * 0x11b);
      rcon &= 0xff;
    } else if (i % Nk === 4) {
      temp =
        (SBOX[(temp >>> 24) & 0xff]! << 24) |
        (SBOX[(temp >>> 16) & 0xff]! << 16) |
        (SBOX[(temp >>> 8) & 0xff]! << 8) |
        SBOX[temp & 0xff]!;
    }
    words[i] = (words[i - Nk]! ^ temp) >>> 0;
  }
  return words;
}

function addRoundKey(state: Uint8Array, words: Uint32Array, wordOffset: number): void {
  for (let c = 0; c < 4; c += 1) {
    const w = words[wordOffset + c]!;
    // FIPS-197 layout: state column c = word bytes (big-endian).
    state[c * 4] = state[c * 4]! ^ ((w >>> 24) & 0xff);
    state[c * 4 + 1] = state[c * 4 + 1]! ^ ((w >>> 16) & 0xff);
    state[c * 4 + 2] = state[c * 4 + 2]! ^ ((w >>> 8) & 0xff);
    state[c * 4 + 3] = state[c * 4 + 3]! ^ (w & 0xff);
  }
}

function xtime(x: number): number {
  const doubled = (x << 1) & 0xff;
  return x & 0x80 ? doubled ^ 0x1b : doubled;
}

const MIX_TABLE = new Uint8Array(512);
(() => {
  for (let x = 0; x < 256; x += 1) {
    MIX_TABLE[x] = xtime(x);
    MIX_TABLE[256 + x] = xtime(x) ^ x;
  }
})();

function aesEncryptBlock(words: Uint32Array, block: Uint8Array): void {
  const Nr = 14;
  const state = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) state[i] = block[i]!;

  addRoundKey(state, words, 0);
  for (let round = 1; round < Nr; round += 1) {
    // SubBytes
    for (let i = 0; i < 16; i += 1) state[i] = SBOX[state[i]!]!;
    // ShiftRows — state is column-major (flat[col*4 + row], see addRoundKey):
    // state'[r][c] = state[r][(c + r) % 4] becomes
    // flat'[c*4 + r] = flat[((c + r) % 4)*4 + r] for rows r ≥ 1.
    const t = state.slice();
    for (let r = 1; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) state[c * 4 + r] = t[((c + r) % 4) * 4 + r]!;
    }
    // MixColumns — b_r = a_r ⊕ t ⊕ 2·(a_r ⊕ a_{r+1}), with t = a0⊕a1⊕a2⊕a3
    // (equivalent to the spec form 2a_r ⊕ 3a_{r+1} ⊕ a_{r+2} ⊕ a_{r+3}).
    for (let c = 0; c < 4; c += 1) {
      const i = c * 4;
      const a0 = state[i]!;
      const a1 = state[i + 1]!;
      const a2 = state[i + 2]!;
      const a3 = state[i + 3]!;
      const t = a0 ^ a1 ^ a2 ^ a3;
      state[i] = a0 ^ t ^ MIX_TABLE[a0 ^ a1]!;
      state[i + 1] = a1 ^ t ^ MIX_TABLE[a1 ^ a2]!;
      state[i + 2] = a2 ^ t ^ MIX_TABLE[a2 ^ a3]!;
      state[i + 3] = a3 ^ t ^ MIX_TABLE[a3 ^ a0]!;
    }
    addRoundKey(state, words, round * 4);
  }
  // Final round (no MixColumns)
  for (let i = 0; i < 16; i += 1) state[i] = SBOX[state[i]!]!;
  const t = state.slice();
  for (let r = 1; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) state[c * 4 + r] = t[((c + r) % 4) * 4 + r]!;
  }
  addRoundKey(state, words, Nr * 4);

  block.set(state);
}

/* ------------------------------------------------------------------ */
/* GHASH + GCM                                                        */
/* ------------------------------------------------------------------ */

/** GF(2^128) multiply for GHASH, constant-time (no data-dependent branches). */
function gf128Mul(x: Uint8Array, y: Uint8Array): Uint8Array {
  const z = new Uint8Array(16);
  const v = y.slice();
  for (let i = 0; i < 128; i += 1) {
    const bit = (x[i >> 3]! >> (7 - (i & 7))) & 1;
    const mask = 0 - bit; // 0xff when the bit is set
    for (let j = 0; j < 16; j += 1) z[j] = z[j]! ^ (v[j]! & mask);
    const lsb = v[15]! & 1;
    let carry = 0;
    for (let j = 0; j < 16; j += 1) {
      const byte = v[j]!;
      const nextCarry = byte & 1;
      v[j] = ((byte >>> 1) | (carry << 7)) & 0xff;
      carry = nextCarry;
    }
    const rMask = 0 - lsb;
    v[0] = v[0]! ^ (rMask & 0xe1);
  }
  return z;
}

function computeJ0(h: Uint8Array, iv: Uint8Array): Uint8Array {
  if (iv.length === 12) {
    const j0 = new Uint8Array(16);
    j0.set(iv, 0);
    j0[15] = 1;
    return j0;
  }
  // Generic IV: GHASH(IV || pad || len(IV))
  const padded = new Uint8Array(Math.ceil(iv.length / 16) * 16 + 16);
  padded.set(iv, 0);
  new DataView(padded.buffer).setUint32(padded.length - 8, iv.length * 8);
  const y = new Uint8Array(16);
  const process = (block: Uint8Array): void => {
    for (let i = 0; i < 16; i += 1) y[i] = y[i]! ^ block[i]!;
    y.set(gf128Mul(y, h));
  };
  for (let offset = 0; offset < padded.length; offset += 16) {
    process(new Uint8Array(padded.subarray(offset, offset + 16)));
  }
  return y;
}

function ghash(h: Uint8Array, data: Uint8Array, additional: Uint8Array | null): Uint8Array {
  const y = new Uint8Array(16);
  const process = (block: Uint8Array): void => {
    for (let i = 0; i < 16; i += 1) y[i] = y[i]! ^ block[i]!;
    y.set(gf128Mul(y, h));
  };
  for (let offset = 0; offset < data.length; offset += 16) {
    const block = new Uint8Array(16);
    block.set(data.subarray(offset, offset + 16));
    process(block);
  }
  if (additional) process(additional);
  return y;
}

/** GCM encrypt with a 12-byte IV. Returns ciphertext||tag (16 bytes). */
export function aesGcmEncrypt(keyWords: Uint32Array, iv: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (iv.length !== 12) throw new Error('GCM fallback requires a 96-bit IV.');
  const hBlock = new Uint8Array(16);
  aesEncryptBlock(keyWords, hBlock);
  const h = hBlock;
  const j0 = computeJ0(h, iv);

  const inc32 = (counter: Uint8Array): void => {
    for (let i = 15; i >= 12; i -= 1) {
      counter[i] = (counter[i]! + 1) & 0xff;
      if (counter[i] !== 0) break;
    }
  };

  const ciphertext = new Uint8Array(plaintext.length);
  // Counter and keystream live in separate buffers: aesEncryptBlock mutates
  // its argument in place, so feeding it the counter would destroy it.
  const counter = j0.slice();
  const ksBlock = new Uint8Array(16);
  for (let offset = 0; offset < plaintext.length; offset += 16) {
    inc32(counter);
    ksBlock.set(counter);
    aesEncryptBlock(keyWords, ksBlock);
    const take = Math.min(16, plaintext.length - offset);
    for (let i = 0; i < take; i += 1) {
      ciphertext[offset + i] = plaintext[offset + i]! ^ ksBlock[i]!;
    }
  }

  const lenBlock = new Uint8Array(16);
  new DataView(lenBlock.buffer).setUint32(12, plaintext.length * 8);
  const y = ghash(h, ciphertext, lenBlock);

  // E(K, J0) into a dedicated buffer: aesEncryptBlock mutates its second
  // argument in place, and j0 must stay pristine for the CTR counters.
  const e0 = j0.slice();
  aesEncryptBlock(keyWords, e0);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) tag[i] = y[i]! ^ e0[i]!;

  const out = new Uint8Array(ciphertext.length + 16);
  out.set(ciphertext, 0);
  out.set(tag, ciphertext.length);
  return out;
}

/** GCM decrypt/verify. Returns null when the tag fails authentication. */
export function aesGcmDecrypt(keyWords: Uint32Array, iv: Uint8Array, data: Uint8Array): Uint8Array | null {
  if (data.length < 16) return null;
  const tag = data.slice(data.length - 16);
  const ciphertext = data.subarray(0, data.length - 16);

  const hBlock = new Uint8Array(16);
  aesEncryptBlock(keyWords, hBlock);
  const h = hBlock;
  const j0 = computeJ0(h, iv);

  const lenBlock = new Uint8Array(16);
  new DataView(lenBlock.buffer).setUint32(12, ciphertext.length * 8);
  const y = ghash(h, ciphertext, lenBlock);

  // Tag check before CTR decryption — with a copy, so j0 survives intact
  // for the counter blocks below (see the encrypt-side comment).
  const e0 = j0.slice();
  aesEncryptBlock(keyWords, e0);
  let diff = 0;
  for (let i = 0; i < 16; i += 1) diff |= y[i]! ^ e0[i]! ^ tag[i]!;
  if (diff !== 0) return null;

  const inc32 = (counter: Uint8Array): void => {
    for (let i = 15; i >= 12; i -= 1) {
      counter[i] = (counter[i]! + 1) & 0xff;
      if (counter[i] !== 0) break;
    }
  };
  const plaintext = new Uint8Array(ciphertext.length);
  // Same counter/keystream separation as the encrypt path.
  const counter = j0.slice();
  const ksBlock = new Uint8Array(16);
  for (let offset = 0; offset < ciphertext.length; offset += 16) {
    inc32(counter);
    ksBlock.set(counter);
    aesEncryptBlock(keyWords, ksBlock);
    const take = Math.min(16, ciphertext.length - offset);
    for (let i = 0; i < take; i += 1) {
      plaintext[offset + i] = ciphertext[offset + i]! ^ ksBlock[i]!;
    }
  }
  return plaintext;
}

/** Constant-time byte compare. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
