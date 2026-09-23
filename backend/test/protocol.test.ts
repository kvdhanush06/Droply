import { describe, expect, it } from 'vitest';
import { parseClientMessage, MAX_SDP_LENGTH } from '../src/protocol.js';

const MAX = 64 * 1024;

describe('parseClientMessage', () => {
  it('accepts create-room', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'create-room' }), MAX);
    expect(result).toEqual({ ok: true, message: { kind: 'create-room' } });
  });

  it('accepts join-room and normalizes the code', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'join-room', roomId: 'k7qf9x2a' }), MAX);
    expect(result).toEqual({ ok: true, message: { kind: 'join-room', roomId: 'K7QF-9X2A' } });
  });

  it('rejects join-room with a bad code', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'join-room', roomId: 'nope' }), MAX);
    expect(result.ok).toBe(false);
  });

  it('accepts an SDP signal to a valid peer', () => {
    const result = parseClientMessage(
      JSON.stringify({ type: 'signal', to: 'AbCdEfGh1234', sdp: 'v=0\r\n…' }),
      MAX,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toMatchObject({ kind: 'signal', to: 'AbCdEfGh1234' });
    }
  });

  it('accepts ICE candidate signals and validates their shape', () => {
    const ok = parseClientMessage(
      JSON.stringify({
        type: 'signal',
        to: 'AbCdEfGh1234',
        candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 56789 typ host', sdpMid: '0', sdpMLineIndex: 0 },
      }),
      MAX,
    );
    expect(ok.ok).toBe(true);

    const bad = parseClientMessage(
      JSON.stringify({ type: 'signal', to: 'AbCdEfGh1234', candidate: { candidate: 42 } }),
      MAX,
    );
    expect(bad.ok).toBe(false);
  });

  it('rejects signals without sdp or candidate', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'signal', to: 'AbCdEfGh1234' }), MAX);
    expect(result.ok).toBe(false);
  });

  it('rejects signals to malformed peer ids', () => {
    const result = parseClientMessage(
      JSON.stringify({ type: 'signal', to: '../../etc', sdp: 'x' }),
      MAX,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects oversized SDP payloads', () => {
    const result = parseClientMessage(
      JSON.stringify({ type: 'signal', to: 'AbCdEfGh1234', sdp: 'x'.repeat(MAX_SDP_LENGTH + 1) }),
      MAX + MAX_SDP_LENGTH + 100,
    );
    expect(result).toMatchObject({ ok: false, code: 'MESSAGE_TOO_LARGE' });
  });

  it('rejects frames larger than the byte cap', () => {
    const result = parseClientMessage('x'.repeat(MAX + 1), MAX);
    expect(result).toMatchObject({ ok: false, code: 'MESSAGE_TOO_LARGE' });
  });

  it('rejects invalid JSON and non-object payloads', () => {
    expect(parseClientMessage('not json', MAX)).toMatchObject({ ok: false, code: 'MALFORMED_MESSAGE' });
    expect(parseClientMessage('[1,2]', MAX).ok).toBe(false);
    expect(parseClientMessage('"str"', MAX).ok).toBe(false);
    expect(parseClientMessage('null', MAX).ok).toBe(false);
    expect(parseClientMessage('{}', MAX).ok).toBe(false);
  });

  it('rejects unknown message types', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'delete-everything' }), MAX);
    expect(result).toMatchObject({ ok: false, code: 'PROTOCOL_ERROR' });
  });
});
