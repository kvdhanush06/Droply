import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  computeTotalChunks,
  generateTransferId,
  parseControlMessage,
  sanitizeFileName,
  serializeControl,
  MAX_TEXT_LENGTH,
  MAX_FILE_SIZE,
  type ControlMessage,
} from '../src/services/transfer/protocol';

function roundTrip(message: ControlMessage): ControlMessage | null {
  return parseControlMessage(serializeControl(message));
}

describe('transfer id generation', () => {
  it('generates 10-char alphanumeric ids', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generateTransferId()).toMatch(/^[A-Za-z0-9]{10}$/);
    }
  });

  it('uses the injected RNG', () => {
    expect(generateTransferId(() => 0)).toBe('a'.repeat(10));
    expect(generateTransferId(() => 0.999999)).toBe('9'.repeat(10));
  });
});

describe('computeTotalChunks', () => {
  it('handles zero, partial and exact multiples', () => {
    expect(computeTotalChunks(0, CHUNK_SIZE)).toBe(0);
    expect(computeTotalChunks(1, CHUNK_SIZE)).toBe(1);
    expect(computeTotalChunks(CHUNK_SIZE, CHUNK_SIZE)).toBe(1);
    expect(computeTotalChunks(CHUNK_SIZE + 1, CHUNK_SIZE)).toBe(2);
    expect(computeTotalChunks(10 * CHUNK_SIZE, CHUNK_SIZE)).toBe(10);
  });
});

describe('sanitizeFileName', () => {
  it('keeps ordinary names intact', () => {
    expect(sanitizeFileName('photo final (2).zip')).toBe('photo final (2).zip');
    expect(sanitizeFileName('résumé.pdf')).toBe('résumé.pdf');
  });

  it('strips path separators and traversal attempts', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeFileName('C:\\Windows\\system32\\x.dll')).toBe('C:_Windows_system32_x.dll');
    expect(sanitizeFileName('..')).toBe('droply-file');
    expect(sanitizeFileName('.')).toBe('droply-file');
  });

  it('removes control characters and trims', () => {
    expect(sanitizeFileName('a\rb\nc\td')).toBe('abcd');
    expect(sanitizeFileName('   ')).toBe('droply-file');
    expect(sanitizeFileName('')).toBe('droply-file');
  });

  it('caps length at 255 characters', () => {
    const long = 'x'.repeat(400) + '.bin';
    expect(sanitizeFileName(long).length).toBeLessThanOrEqual(255);
  });
});

describe('control message parsing', () => {
  it('round-trips hello', () => {
    expect(roundTrip({ type: 'hello', protocol: 1 })).toEqual({ type: 'hello', protocol: 1 });
  });

  it('round-trips hello with a device name', () => {
    expect(roundTrip({ type: 'hello', protocol: 1, name: 'Maya’s Laptop' })).toEqual({
      type: 'hello',
      protocol: 1,
      name: 'Maya’s Laptop',
    });
  });

  it('rejects an overlong hello name', () => {
    expect(roundTrip({ type: 'hello', protocol: 1, name: 'x'.repeat(200) })).toBeNull();
  });

  it('round-trips file-start with metadata', () => {
    const msg: ControlMessage = {
      type: 'file-start',
      transferId: 'abc123XYZ9',
      batchId: 'b1abcdefgh',
      offset: 0,
      file: { name: 'a.bin', size: CHUNK_SIZE * 3, mimeType: 'application/octet-stream', chunkSize: CHUNK_SIZE, totalChunks: 3 },
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('round-trips a consent offer', () => {
    const msg: ControlMessage = {
      type: 'offer',
      batchId: 'b1abcdefgh',
      secure: true,
      items: [
        { name: 'a.bin', size: CHUNK_SIZE, mimeType: 'application/octet-stream', chunkSize: CHUNK_SIZE, totalChunks: 1 },
      ],
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('round-trips an offer response with selected indices', () => {
    const msg: ControlMessage = { type: 'offer-response', batchId: 'b1abcdefgh', decision: 'accepted', items: [0, 2] };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('round-trips auth handshake frames', () => {
    const salt = Array.from({ length: 16 }, (_, i) => i);
    const challenge: ControlMessage = { type: 'auth-challenge', batchId: 'b1abcdefgh', salt, iterations: 250000 };
    expect(roundTrip(challenge)).toEqual(challenge);
    const verify: ControlMessage = { type: 'auth-verify', batchId: 'b1abcdefgh', proof: salt };
    expect(roundTrip(verify)).toEqual(verify);
    const result: ControlMessage = { type: 'auth-result', batchId: 'b1abcdefgh', ok: true };
    expect(roundTrip(result)).toEqual(result);
  });

  it('sanitizes hostile file metadata', () => {
    const parsed = parseControlMessage(
      JSON.stringify({
        type: 'file-start',
        transferId: 'abc123XYZ9',
        batchId: 'b1abcdefgh',
        offset: 0,
        file: { name: '..\\..\\evil.exe', size: 10, mimeType: 'x', chunkSize: CHUNK_SIZE, totalChunks: 1 },
      }),
    );
    expect(parsed).not.toBeNull();
    if (parsed?.type === 'file-start') {
      expect(parsed.file.name).not.toContain('\\');
      expect(parsed.file.name).not.toContain('..\\');
    }
  });

  it('rejects metadata with inconsistent chunk math', () => {
    expect(
      parseControlMessage(
        JSON.stringify({
          type: 'file-start',
          transferId: 'abc123XYZ9',
          file: { name: 'a', size: 100, mimeType: 'x', chunkSize: CHUNK_SIZE, totalChunks: 5 },
        }),
      ),
    ).toBeNull();
  });

  it('rejects absurd file sizes', () => {
    expect(
      parseControlMessage(
        JSON.stringify({
          type: 'file-start',
          transferId: 'abc123XYZ9',
          file: { name: 'a', size: MAX_FILE_SIZE + 1, mimeType: 'x', chunkSize: CHUNK_SIZE, totalChunks: 0 },
        }),
      ),
    ).toBeNull();
  });

  it('round-trips text and enforces the length limit', () => {
    const ok = roundTrip({ type: 'text', id: 'abc123XYZ9', text: 'hello peer' });
    expect(ok).toMatchObject({ type: 'text', text: 'hello peer' });

    const tooLong = parseControlMessage(
      JSON.stringify({ type: 'text', id: 'abc123XYZ9', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }),
    );
    expect(tooLong).toBeNull();
    expect(parseControlMessage(JSON.stringify({ type: 'text', id: 'abc123XYZ9', text: '' }))).toBeNull();
  });

  it('round-trips cancel/ack/end/error', () => {
    expect(roundTrip({ type: 'file-end', transferId: 'abc123XYZ9' })).toEqual({ type: 'file-end', transferId: 'abc123XYZ9' });
    expect(roundTrip({ type: 'transfer-ack', transferId: 'abc123XYZ9' })).toEqual({ type: 'transfer-ack', transferId: 'abc123XYZ9' });
    expect(roundTrip({ type: 'transfer-cancel', transferId: 'abc123XYZ9', reason: 'user' })).toMatchObject({ reason: 'user' });
    expect(roundTrip({ type: 'transfer-error', transferId: 'abc123XYZ9', message: 'boom' })).toMatchObject({ message: 'boom' });
  });

  it('rejects garbage input', () => {
    expect(parseControlMessage('not json')).toBeNull();
    expect(parseControlMessage('{}')).toBeNull();
    expect(parseControlMessage('[]')).toBeNull();
    expect(parseControlMessage(JSON.stringify({ type: 'unknown' }))).toBeNull();
    expect(parseControlMessage(JSON.stringify({ type: 'file-end', transferId: '<script>' }))).toBeNull();
  });
});
