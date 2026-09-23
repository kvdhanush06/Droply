import { readFileSync } from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';

/**
 * Queues a file through the app's real drop zone.
 *
 * `setInputFiles` assigns the files via the browser protocol; some Chromium
 * builds do not emit a DOM `change` event for that assignment, in which case
 * the app's handler never runs. This helper detects that case and dispatches
 * the event itself, so the assertion that follows always tests real app
 * behaviour rather than a browser quirk.
 */
async function queueFile(page: Page, name: string, mimeType: string, payload: string): Promise<void> {
  const items = page.locator('li.transfer-item');
  const before = await items.count();
  const file = { name, mimeType, buffer: Buffer.from(payload) };

  // Preferred path: drive the real file chooser that the drop zone opens, which
  // is exactly what a user does and guarantees the app's change handler runs.
  let queuedViaChooser = false;
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      page.locator('.dropzone').click(),
    ]);
    await chooser.setFiles(file);
    queuedViaChooser = true;
  } catch {
    queuedViaChooser = false;
  }

  if (!queuedViaChooser) {
    // Fallback: assign the files to the hidden input directly and make sure the
    // change event is delivered.
    const input = page.locator('input[type="file"]');
    await input.setInputFiles(file);
    await input.dispatchEvent('change');
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await items.count()) > before) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`The app never queued the file "${name}".`);
}

/**
 * Names a device on a fresh page (device names are mandatory and stored in
 * localStorage, so contexts must be isolated per device).
 */
async function nameDevice(page: Page, name: string): Promise<void> {
  await page.getByLabel(/this device.s name/i).first().fill(name);
  // On the room page a mandatory gate collects the name — submit it so the
  // session joins; on the landing page the fill alone is enough.
  const gateButton = page.getByRole('button', { name: /save.*join the room/i });
  if ((await gateButton.count()) > 0) {
    await gateButton.click();
  }
}

/**
 * Accepts a pending consent offer on the receiving device.
 * Transfers are consent-first: no bytes move until B accepts.
 */
async function acceptOffer(page: Page): Promise<void> {
  await expect(page.getByText(/wants to send you/i)).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: /accept all/i }).click();
}

/**
 * Full peer-to-peer flow in real Chromium instances:
 * 1. Device A names itself and creates a room.
 * 2. Device B names itself and joins with the shared link.
 * 3. WebRTC connects (loopback on localhost needs no STUN).
 * 4. A sends text to B; B receives and displays it.
 * 5. A sends a small and a multi-MB file; B consents and receives
 *    byte-identical content.
 */
test('two browsers connect and exchange text and files', async ({ browser }) => {
  test.setTimeout(300_000);

  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await pageA.goto('/');
  await nameDevice(pageA, 'Device A');
  await pageA.getByRole('button', { name: /create a room/i }).click();
  await expect(pageA.locator('#room-heading')).toBeVisible({ timeout: 15000 });

  const roomUrl = pageA.url();
  expect(roomUrl).toMatch(/\/room\/[A-Z2-9-]{9}$/);

  await pageB.goto(roomUrl);
  await nameDevice(pageB, 'Device B');
  await expect(pageB.locator('#room-heading')).toBeVisible({ timeout: 15000 });

  // The devices announce each other by name in the device list.
  await expect(pageA.getByText('Device B')).toBeVisible({ timeout: 60000 });
  await expect(pageB.getByText('Device A')).toBeVisible({ timeout: 60000 });

  // Both peers must report the DataChannel as connected.
  await expect(pageA.locator('.badge-success')).toHaveText('Connected', { timeout: 60000 });
  await expect(pageB.locator('.badge-success')).toHaveText('Connected', { timeout: 60000 });

  // The drop zone unlocks only once a peer is connected.
  await expect(pageA.locator('.dropzone')).toHaveAttribute('aria-disabled', 'false', { timeout: 15000 });

  // --- text: A -> B ---
  const message = `hello from A ${Date.now()}`;
  await pageA.getByLabel(/write something to send/i).fill(message);
  await pageA.getByRole('button', { name: /send text/i }).click();
  await expect(pageB.getByText(message)).toBeVisible({ timeout: 20000 });

  // --- small file: A -> B (B consents first) ---
  const smallPayload = 'droply-e2e-small:'.repeat(64); // 1 KiB
  await queueFile(pageA, 'e2e-small.txt', 'text/plain', smallPayload);
  await acceptOffer(pageB);
  const smallLink = pageB.locator('a[download="e2e-small.txt"]').first();
  await expect(smallLink).toBeVisible({ timeout: 60000 });

  // --- large multi-chunk file: A -> B ---
  const largePayload = 'droply-e2e-payload:'.repeat(300_000); // ~6 MiB
  await queueFile(pageA, 'e2e-large.bin', 'application/octet-stream', largePayload);
  await acceptOffer(pageB);
  const largeLink = pageB.locator('a[download="e2e-large.bin"]').first();
  await expect(largeLink).toBeVisible({ timeout: 120000 });

  // Verify both received files through the real download path: clicking the
  // Save link triggers the browser download, and the file on disk must be
  // byte-identical to what was sent.
  const verifyDownload = async (link: Locator, expectedName: string, expectedPayload: string) => {
    const [download] = await Promise.all([
      pageB.waitForEvent('download', { timeout: 30000 }),
      link.click(),
    ]);
    expect(download.suggestedFilename()).toBe(expectedName);
    expect(await download.failure()).toBeNull();
    const tmpPath = await download.path();
    expect(tmpPath).toBeTruthy();
    expect(readFileSync(tmpPath!, 'utf8')).toBe(expectedPayload);
  };

  await verifyDownload(smallLink, 'e2e-small.txt', smallPayload);
  await verifyDownload(largeLink, 'e2e-large.bin', largePayload);

  await pageA.close();
  await pageB.close();
});

test('landing page copy, invalid room code and 404 handling', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /send files/i })).toBeVisible();

  // A malformed room code is explained on the room page itself.
  await page.goto('/room/NOPE');
  await expect(page.locator('h1')).toHaveText(/That room link doesn.t look right/);
  await expect(page.getByText(/8-character room code/i)).toBeVisible();

  // An unknown route falls through to the 404 page.
  await page.goto('/not-a-real-page');
  await expect(page.locator('h1')).toContainText('404');
  await expect(page.getByText(/doesn.t exist/i)).toBeVisible();
});


