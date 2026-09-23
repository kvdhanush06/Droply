import { describe, expect, it } from 'vitest';
import { validateServerMessage } from '../src/services/signaling/signalingClient';

describe('validateServerMessage', () => {
  it('accepts a valid room-created', () => {
    const msg = validateServerMessage({ type: 'room-created', roomId: 'K7QF-9X2A', peerId: 'AbCdEfGh1234', expiresAt: 123 });
    expect(msg).toEqual({ type: 'room-created', roomId: 'K7QF-9X2A', peerId: 'AbCdEfGh1234', expiresAt: 123 });
  });

  it('rejects room-created with bad shapes', () => {
    expect(validateServerMessage({ type: 'room-created', roomId: 'nope', peerId: 'AbCdEfGh1234' })).toBeNull();
    expect(validateServerMessage({ type: 'room-created', roomId: 'K7QF-9X2A', peerId: 'short' })).toBeNull();
    expect(validateServerMessage(null)).toBeNull();
    expect(validateServerMessage('room-created')).toBeNull();
    expect(validateServerMessage([1])).toBeNull();
  });

  it('filters invalid peer ids from room-joined lists', () => {
    const msg = validateServerMessage({
      type: 'room-joined',
      roomId: 'K7QF-9X2A',
      peerId: 'AbCdEfGh1234',
      peers: ['ZZZZxxxx9999', '../evil', 42],
    });
    expect(msg).toMatchObject({ peers: ['ZZZZxxxx9999'] });
  });

  it('accepts signals with sdp or candidate', () => {
    expect(
      validateServerMessage({ type: 'signal', from: 'AbCdEfGh1234', sdp: 'v=0' }),
    ).toMatchObject({ type: 'signal', sdp: 'v=0' });
    expect(
      validateServerMessage({ type: 'signal', from: 'AbCdEfGh1234', candidate: { candidate: 'c', sdpMid: '0' } }),
    ).toMatchObject({ type: 'signal' });
  });

  it('rejects signals with oversized SDP', () => {
    expect(
      validateServerMessage({ type: 'signal', from: 'AbCdEfGh1234', sdp: 'x'.repeat(40 * 1024) }),
    ).toBeNull();
  });

  it('accepts known error codes and rejects unknown ones', () => {
    expect(validateServerMessage({ type: 'error', code: 'ROOM_FULL', message: 'full' })).toMatchObject({
      code: 'ROOM_FULL',
      message: 'full',
    });
    expect(validateServerMessage({ type: 'error', code: 'HACKED', message: 'x' })).toBeNull();
  });

  it('accepts room-expired, peer-joined, peer-left', () => {
    expect(validateServerMessage({ type: 'room-expired', roomId: 'K7QF-9X2A' })).toEqual({
      type: 'room-expired',
      roomId: 'K7QF-9X2A',
    });
    expect(validateServerMessage({ type: 'peer-joined', peerId: 'AbCdEfGh1234' })).not.toBeNull();
    expect(validateServerMessage({ type: 'peer-left', peerId: 'AbCdEfGh1234' })).not.toBeNull();
    expect(validateServerMessage({ type: 'peer-left', peerId: 'bad' })).toBeNull();
  });
});
