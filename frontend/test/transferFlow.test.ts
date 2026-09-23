import { describe, expect, it } from 'vitest';
import {
  TransferEngine,
  type TransferEngineEvents,
} from '../src/services/transfer/fileTransfer';
import { InlineChunkSource } from '../src/services/transfer/chunkSource';
import type { PeerConnection } from '../src/services/webrtc/peerConnection';
import type { TransferItem } from '../src/types';

/**
 * Two connected engines whose frames are delivered synchronously to each
 * other, so tests are fully deterministic: no real WebRTC, no worker pool
 * (the InlineChunkSource reads on the main thread), no timers beyond the
 * event-loop turns the engine itself needs.
 */
interface Harness {
  engineA: TransferEngine;
  engineB: TransferEngine;
  itemsA: TransferItem[];
  itemsB: TransferItem[];
  offersB: { batchId: string; secure: boolean; count: number }[];
  settledB: string[];
  passwordB: string[];
}

function makeFile(name: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' });
}

function setupHarness(): Harness {
  const h = {} as Harness;
  h.itemsA = [];
  h.itemsB = [];
  h.offersB = [];
  h.settledB = [];
  h.passwordB = [];

  const eventsFor = (side: 'a' | 'b'): TransferEngineEvents => ({
    onTransferUpdate: (item) => {
      const list = side === 'a' ? h.itemsA : h.itemsB;
      const index = list.findIndex((t) => t.transferId === item.transferId);
      if (index >= 0) list[index] = item;
      else list.push(item);
    },
    onText: () => undefined,
    onOfferReceived: (offer) => {
      if (side !== 'b') return;
      h.offersB.push({ batchId: offer.batchId, secure: offer.secure, count: offer.items.length });
    },
    onPasswordRequired: (batchId) => {
      if (side === 'b') h.passwordB.push(batchId);
    },
    onOfferSettled: (batchId) => {
      if (side === 'b') h.settledB.push(batchId);
    },
  });

  let engineA: TransferEngine | null = null;
  let engineB: TransferEngine | null = null;

  const facadeFor = (deliver: (frame: string | ArrayBuffer) => void): PeerConnection =>
    ({
      isChannelOpen: () => true,
      getBufferedAmount: () => 0,
      waitForBufferDrain: () => Promise.resolve(),
      flushWrites: () => Promise.resolve(),
      sendText: (payload: string) => deliver(payload),
      sendBinary: (buffer: ArrayBuffer) => deliver(buffer),
    }) as unknown as PeerConnection;

  const deliverToB = (frame: string | ArrayBuffer) => engineB!.handleData(frame);
  const deliverToA = (frame: string | ArrayBuffer) => engineA!.handleData(frame);

  engineA = new TransferEngine(facadeFor(deliverToB), eventsFor('a'), new InlineChunkSource());
  engineB = new TransferEngine(facadeFor(deliverToA), eventsFor('b'), new InlineChunkSource());

  h.engineA = engineA;
  h.engineB = engineB;
  return h;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('transfer consent flow', () => {
  it('sends no file bytes before the receiver accepts', async () => {
    const h = setupHarness();
    void h.engineA.enqueue([{ file: makeFile('a.bin', 100) }], { zip: false, zipLevel: 0, password: null });
    await tick();

    expect(h.offersB).toHaveLength(1);
    expect(h.offersB[0]!.count).toBe(1);
    expect(h.itemsB).toHaveLength(0); // receiver got no data
    expect(h.itemsA.some((t) => t.status === 'queued')).toBe(true); // sender shows pending consent
  });

  it('delivers the file after acceptance and marks both sides complete', async () => {
    const h = setupHarness();
    const bytes = 40;
    void h.engineA.enqueue([{ file: makeFile('a.bin', bytes) }], { zip: false, zipLevel: 0, password: null });
    await tick();

    expect(h.engineB.respondToOffer(h.offersB[0]!.batchId, { decision: 'accepted' })).toBe(true);
    await tick(150);

    const incoming = h.itemsB.find((t) => t.direction === 'incoming');
    expect(incoming).toBeDefined();
    expect(incoming!.status).toBe('completed');
    expect(incoming!.bytesTransferred).toBe(bytes);
    expect(incoming!.downloadUrl).toBeNull(); // jsdom has no createObjectURL
    const outgoing = h.itemsA.find((t) => t.direction === 'outgoing');
    expect(outgoing!.status).toBe('completed');
  });

  it('marks the batch cancelled on the sender when the receiver declines', async () => {
    const h = setupHarness();
    void h.engineA.enqueue([{ file: makeFile('b.bin', 50) }], { zip: false, zipLevel: 0, password: null });
    await tick();

    expect(h.engineB.respondToOffer(h.offersB[0]!.batchId, { decision: 'declined' })).toBe(true);
    await tick(40);

    const outgoing = h.itemsA.find((t) => t.direction === 'outgoing');
    expect(outgoing!.status).toBe('cancelled');
    expect(h.itemsB.find((t) => t.direction === 'incoming')).toBeUndefined();
  });

  it('supports per-item selection on multi-file offers', async () => {
    const h = setupHarness();
    void h.engineA.enqueue(
      [{ file: makeFile('one.bin', 30) }, { file: makeFile('two.bin', 40) }],
      { zip: false, zipLevel: 0, password: null },
    );
    await tick();

    expect(h.offersB[0]!.count).toBe(2);
    h.engineB.respondToOffer(h.offersB[0]!.batchId, { decision: 'accepted', selected: [1] });
    await tick(150);

    const completed = h.itemsB.filter((t) => t.status === 'completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.size).toBe(40);
  });

  it('notifies the receiver UI when an offer settles', async () => {
    const h = setupHarness();
    void h.engineA.enqueue([{ file: makeFile('c.bin', 10) }], { zip: false, zipLevel: 0, password: null });
    await tick();
    h.engineB.respondToOffer(h.offersB[0]!.batchId, { decision: 'accepted' });
    expect(h.settledB).toContain(h.offersB[0]!.batchId);
  });

  it('delivers only the selected items of a multi-file offer', async () => {
    const h = setupHarness();
    void h.engineA.enqueue([{ file: makeFile('one.bin', 10) }, { file: makeFile('two.bin', 20) }], {
      zip: false,
      zipLevel: 0,
      password: null,
    });
    await tick();

    h.engineB.respondToOffer(h.offersB[0]!.batchId, { decision: 'accepted', selected: [1] });
    await tick(300);

    const incoming = h.itemsB.filter((t) => t.direction === 'incoming');
    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.name).toBe('two.bin');
    expect(incoming[0]!.status).toBe('completed');
    const skipped = h.itemsA.find((t) => t.name === 'one.bin');
    expect(skipped!.status).toBe('cancelled');
  }, 20000);

  it('delivers a single-file offer accepted via accept-selected', async () => {
    const h = setupHarness();
    void h.engineA.enqueue([{ file: makeFile('solo.bin', 32) }], { zip: false, zipLevel: 0, password: null });
    await tick();

    h.engineB.respondToOffer(h.offersB[0]!.batchId, { decision: 'accepted', selected: [0] });
    await tick(300);

    const incoming = h.itemsB.find((t) => t.direction === 'incoming');
    expect(incoming).toBeDefined();
    expect(incoming!.status).toBe('completed');
    expect(incoming!.bytesTransferred).toBe(32);
  }, 20000);
});

describe('password-protected transfers', () => {
  it('completes the handshake and transfers encrypted bytes with the correct password', async () => {
    const h = setupHarness();
    const bytes = 500;
    void h.engineA.enqueue([{ file: makeFile('secret.bin', bytes) }], {
      zip: false,
      zipLevel: 0,
      password: 'hunter2',
    });
    await tick();

    expect(h.offersB[0]!.secure).toBe(true);
    h.engineB.respondToOffer(h.offersB[0]!.batchId, { decision: 'accepted' }, 'hunter2');
    await h.engineB.submitPassword(h.offersB[0]!.batchId, 'hunter2');
    await tick(300);

    const incoming = h.itemsB.find((t) => t.direction === 'incoming');
    expect(incoming).toBeDefined();
    expect(incoming!.status).toBe('completed');
    expect(incoming!.bytesTransferred).toBe(bytes);
  }, 20000);

  it('fails the transfer when the receiver keeps entering the wrong password', async () => {
    const h = setupHarness();
    void h.engineA.enqueue([{ file: makeFile('secret2.bin', 500) }], {
      zip: false,
      zipLevel: 0,
      password: 'correct-horse',
    });
    await tick();

    h.engineB.respondToOffer(h.offersB[0]!.batchId, { decision: 'accepted' }, 'wrong-password');
    // The sender allows a few attempts before failing the batch.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await h.engineB.submitPassword(h.offersB[0]!.batchId, 'wrong-password');
      await tick(300);
    }

    const outgoing = h.itemsA.find((t) => t.direction === 'outgoing');
    expect(outgoing!.status).toBe('failed');
    expect(outgoing!.error).toMatch(/password/i);
    expect(h.itemsB.find((t) => t.direction === 'incoming')).toBeUndefined();
  }, 20000);

  it('lets the receiver retry with the correct password after a wrong one', async () => {
    const h = setupHarness();
    const bytes = 500;
    void h.engineA.enqueue([{ file: makeFile('secret3.bin', bytes) }], {
      zip: false,
      zipLevel: 0,
      password: 'right-one',
    });
    await tick();

    h.engineB.respondToOffer(h.offersB[0]!.batchId, { decision: 'accepted' }, 'nope');
    await h.engineB.submitPassword(h.offersB[0]!.batchId, 'nope');
    await tick(400); // attempt fails, receiver is allowed to retry

    const retried = await h.engineB.submitPassword(h.offersB[0]!.batchId, 'right-one');
    expect(retried).toBe(true);
    await tick(500);

    const incoming = h.itemsB.find((t) => t.direction === 'incoming');
    expect(incoming).toBeDefined();
    expect(incoming!.status).toBe('completed');
    expect(incoming!.bytesTransferred).toBe(bytes);
    expect(incoming!.secure).toBe(true);
  }, 20000);

  it('fails the sender batch promptly when the receiver declines the password prompt', async () => {
    const h = setupHarness();
    void h.engineA.enqueue([{ file: makeFile('secret4.bin', 200) }], {
      zip: false,
      zipLevel: 0,
      password: 'never-entered',
    });
    await tick();

    h.engineB.respondToOffer(h.offersB[0]!.batchId, { decision: 'accepted' });
    await tick();
    expect(h.passwordB).toContain(h.offersB[0]!.batchId); // receiver sees the prompt

    // Receiver abandons the prompt instead of entering a password.
    expect(h.engineB.cancelPassword(h.offersB[0]!.batchId)).toBe(true);
    await tick(200);

    const outgoing = h.itemsA.find((t) => t.direction === 'outgoing');
    expect(outgoing).toBeDefined();
    expect(outgoing!.status).toBe('failed');
    expect(outgoing!.error).toMatch(/password step was not completed/i);
    expect(h.itemsB.find((t) => t.direction === 'incoming')).toBeUndefined();
  }, 20000);
});

describe('sender queue resilience', () => {
  it('drains both batches immediately so a second file shows waiting right away', async () => {
    const h = setupHarness();
    // Enqueue a second batch before the first one settles. The old sequential
    // loop would have parked the second batch in the queue; the new loop
    // shifts every queued batch out immediately so both show their consent
    // offer at once (the actual byte streaming stays serialized per peer).
    void h.engineA.enqueue([{ file: makeFile('d.bin', 10) }], { zip: false, zipLevel: 0, password: null });
    void h.engineA.enqueue([{ file: makeFile('e.bin', 10) }], { zip: false, zipLevel: 0, password: null });
    await tick();

    expect(h.offersB).toHaveLength(2);
    expect(h.offersB.map((o) => o.count)).toEqual([1, 1]);
    expect(h.engineA.hasPendingQueue()).toBe(false);
    expect(h.engineA.drainQueue()).toEqual([]);

    // Accepting both completes both files.
    h.engineB.respondToOffer(h.offersB[0]!.batchId, { decision: 'accepted' });
    h.engineB.respondToOffer(h.offersB[1]!.batchId, { decision: 'accepted' });
    await tick(300);

    const incoming = h.itemsB.filter((t) => t.direction === 'incoming');
    expect(incoming).toHaveLength(2);
    expect(incoming.map((t) => t.name)).toEqual(['d.bin', 'e.bin']);
    expect(incoming.every((t) => t.status === 'completed')).toBe(true);
  });

  it('zones multi-file batches into a single bundle when requested', async () => {
    const h = setupHarness();
    void h.engineA.enqueue(
      [{ file: makeFile('x.txt', 100) }, { file: makeFile('y.txt', 200) }],
      { zip: true, zipLevel: 0, password: null },
    );
    await tick(50);

    expect(h.offersB[0]!.count).toBe(1); // one bundle, not two files
    h.engineB.respondToOffer(h.offersB[0]!.batchId, { decision: 'accepted' });
    await tick(250);

    const incoming = h.itemsB.find((t) => t.direction === 'incoming');
    expect(incoming).toBeDefined();
    expect(incoming!.name).toBe('bundle.zip');
    expect(incoming!.status).toBe('completed');
    expect(incoming!.bytesTransferred).toBeGreaterThan(250);
  }, 20000);
});

describe('sender-side cancellation', () => {
  it('withdraws the pending offer so the receiver card disappears immediately', async () => {
    const h = setupHarness();
    const withdrawn: string[] = [];
    h.engineB.events.onOfferWithdrawn = (batchId) => withdrawn.push(batchId);

    void h.engineA.enqueue([{ file: makeFile('gone.bin', 80) }], {
      zip: false,
      zipLevel: 0,
      password: null,
    });
    await tick();
    const batchId = h.offersB[0]!.batchId;
    expect(h.offersB).toHaveLength(1);

    // Sender cancels while the offer is still pending on the receiver.
    h.engineA.cancelBatch(batchId, true);
    await tick(40);

    // The receiver saw an explicit withdrawal, not a user decline, and its
    // pending offer is gone: a later Accept must be a no-op.
    expect(withdrawn).toContain(batchId);
    expect(h.engineB.respondToOffer(batchId, { decision: 'accepted' })).toBe(false);
    expect(h.itemsB.find((t) => t.direction === 'incoming')).toBeUndefined();
  });

  it('cancels a secure accepted batch on the sender and blocks a late password entry', async () => {
    const h = setupHarness();
    void h.engineA.enqueue([{ file: makeFile('secret-gone.bin', 120) }], {
      zip: false,
      zipLevel: 0,
      password: 'pw',
    });
    await tick();
    const batchId = h.offersB[0]!.batchId;
    h.engineB.respondToOffer(batchId, { decision: 'accepted' });
    await tick();

    // Sender withdraws after acceptance but before the password handshake.
    h.engineA.cancelBatch(batchId, true);
    await tick(40);

    // The receiver's password entry can no longer revive the batch.
    await expect(h.engineB.submitPassword(batchId, 'pw')).resolves.toBe(false);
    const outgoing = h.itemsA.find((t) => t.direction === 'outgoing');
    // The sender cancelled its own batch: the item must not linger as
    // "waiting" nor be mislabeled as a receiver-side failure.
    expect(outgoing!.status).toBe('cancelled');
    expect(outgoing!.error).toBe('Cancelled.');
  }, 20000);
});
