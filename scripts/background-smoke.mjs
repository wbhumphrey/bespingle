import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    window.__captures = [];
    window.__pcs = [];
    const Peer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer { constructor(...args) { super(...args); window.__pcs.push(this); } };
    window.__workers = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker { constructor(...args) { super(...args); window.__workers.push(this); } terminate() { this.terminated = true; super.terminate(); } };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (options) => { const stream = await capture(options); window.__captures.push(stream); return stream; };
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR', e));
  page.on('console', (m) => { if (m.type() === 'error') console.error(m.text()); });
  await page.goto(process.env.BESPINGLE_URL || 'http://127.0.0.1:5555');
  await page.getByLabel('Your display name').fill('Background test');
  await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await page.getByRole('button', { name: 'Camera background', exact: true }).click();
  await page.getByRole('button', { name: 'Sky', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Turn camera on', exact: true }).click();
  await page.getByRole('button', { name: 'Turn camera off', exact: true }).waitFor({ timeout: 45000 });
  await page.getByRole('button', { name: 'Camera background', exact: true }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector('.background-preview video');
    return video?.srcObject?.getVideoTracks()[0]?.readyState === 'live' && video.videoWidth > 0;
  });
  assert(await page.evaluate(() => document.querySelector('.background-preview video').srcObject.getVideoTracks()[0].id !== window.__captures[0].getVideoTracks()[0].id), 'Preview uses the processed track');
  const pixel = await page.evaluate(() => {
    const video = document.querySelector('.background-preview video'); const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight; const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0); return [...ctx.getImageData(5, 5, 1, 1).data];
  });
  assert(pixel[2] > pixel[0], `Sky background is composited: ${pixel}`);
  await page.getByRole('button', { name: 'Blur', exact: true }).click();
  await page.getByRole('button', { name: 'Blur', exact: true }).and(page.locator('[aria-pressed="true"]')).waitFor({ timeout: 45000 });
  await page.getByRole('button', { name: 'None', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.background-preview video').srcObject.getVideoTracks()[0].id === window.__captures[0].getVideoTracks()[0].id);
  assert.equal(await page.evaluate(() => window.__captures.length), 1, 'Changing effects reuses the physical camera');
  await page.getByRole('button', { name: 'Forest', exact: true }).click();
  await page.getByRole('button', { name: 'Forest', exact: true }).and(page.locator('[aria-pressed="true"]')).waitFor({ timeout: 45000 });
  await page.screenshot({ path: 'test-results/background.png' });
  await page.getByLabel('Background image', { exact: true }).setInputFiles({ name: 'custom.png', mimeType: 'image/png', buffer: await page.evaluate(async () => { const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 20; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 20, 20); return [...new Uint8Array(await (await new Promise((resolve) => canvas.toBlob(resolve))).arrayBuffer())]; }).then((bytes) => Buffer.from(bytes)) });
  await page.waitForFunction(() => document.querySelector('.background-upload').getAttribute('aria-pressed') === 'true');
  await page.waitForFunction(() => { const video = document.querySelector('.background-preview video'); const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 20; const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 20, 20); const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data; return r > 230 && g < 25 && b < 25; });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Turn microphone on', exact: true }).click();
  await page.getByRole('button', { name: 'Turn microphone off', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__captures.filter((stream) => stream.getVideoTracks().length).length), 1, 'Microphone changes retain the processed camera');
  await page.getByRole('button', { name: 'Turn microphone off', exact: true }).click();
  await page.getByRole('button', { name: 'Turn microphone on', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Turn camera off', exact: true }).click();
  await page.getByRole('button', { name: 'Turn camera on', exact: true }).waitFor();
  assert(await page.evaluate(() => window.__captures.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))), 'Turning camera off releases physical capture');
  await page.getByRole('button', { name: 'Turn camera on', exact: true }).click();
  await page.getByRole('button', { name: 'Turn camera off', exact: true }).waitFor({ timeout: 45000 });
  await page.getByRole('button', { name: 'Camera background', exact: true }).click();
  await page.route('**/models/*.tflite', (route) => route.abort());
  await page.getByRole('button', { name: 'Blur', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not apply camera background' }).waitFor();
  assert.equal(await page.locator('.background-upload').getAttribute('aria-pressed'), 'true', 'Failed initialization preserves the active effect');
  await page.unroute('**/models/*.tflite');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  // Verify the effect survives the real peer connection, including receive-only peers.
  await page.locator('[data-testid="game-canvas"]').focus();
  await page.keyboard.down('w');
  await page.locator('.call-strip.has-conversation').waitFor();
  await page.keyboard.up('w');
  const peer = await context.newPage();
  await peer.goto(process.env.BESPINGLE_URL || 'http://127.0.0.1:5555');
  await peer.getByLabel('Your display name').fill('Background receiver');
  await peer.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await peer.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  await peer.waitForFunction(() => Number(document.querySelector('[data-testid="game-canvas"]').dataset.x) > 0);
  const game = peer.locator('[data-testid="game-canvas"]');
  await game.focus();
  for (let i = 0; i < 2; i++) {
    const x = Number(await game.getAttribute('data-x')) - 48;
    await peer.keyboard.down('a'); await peer.waitForTimeout(35); await peer.keyboard.up('a');
    await peer.waitForFunction((x) => Number(document.querySelector('[data-testid="game-canvas"]').dataset.x) === x && document.querySelector('[data-testid="game-canvas"]').dataset.moving !== 'true', x);
  }
  await peer.keyboard.down('w');
  await peer.getByRole('dialog').waitFor(); await peer.keyboard.up('w');
  await peer.getByRole('button', { name: 'Neither', exact: false }).click();
  await peer.waitForFunction(() => {
    const video = document.querySelector('[data-testid="video-peer"] video');
    if (!video?.videoWidth) return false;
    const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 20;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 20, 20);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data; return r > 220 && g < 40 && b < 40;
  }, null, { timeout: 20000 });
  assert(await page.evaluate(() => window.__pcs.some((pc) => pc.getSenders().some((sender) => sender.track?.kind === 'video' && sender.track.id !== window.__captures.findLast((stream) => stream.getVideoTracks().length).getVideoTracks()[0].id))), 'Peers receive the processed camera track');
  await peer.close();
  await page.evaluate(() => window.__workers.findLast((worker) => !worker.terminated).dispatchEvent(new Event('error')));
  await page.getByRole('button', { name: 'Turn camera on', exact: true }).waitFor();
  assert(await page.evaluate(() => window.__captures.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))), 'Runtime failure stops physical capture instead of exposing the background');
  await page.getByRole('button', { name: 'Leave office', exact: true }).click();
  await page.getByRole('button', { name: 'Enter the office', exact: true }).waitFor();
  assert(await page.evaluate(() => window.__captures.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))), 'Leaving releases capture');

  // The choice, and a custom image, are remembered in this browser and applied to the next camera.
  const url = process.env.BESPINGLE_URL || 'http://127.0.0.1:5555';
  const revisit = async () => {
    await page.goto(url);
    await page.getByLabel('Your display name').fill('Background test');
    await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
    await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
    // Entering again returns to the last tile; on a carpet that asks at once.
    if (await page.locator('.call-strip.has-conversation').count()) {
      await page.getByRole('button', { name: 'Neither', exact: false }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    await page.getByRole('button', { name: 'Camera background', exact: true }).click();
  };
  const pressed = (name) => name === 'custom' ? page.locator('.background-upload[aria-pressed="true"]') : page.getByRole('button', { name, exact: true }).and(page.locator('[aria-pressed="true"]'));
  const cornerPixel = (test) => page.waitForFunction((test) => {
    const video = document.querySelector('.background-preview video');
    if (!video?.videoWidth) return false;
    const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 20;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 20, 20);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data; return new Function('r', 'g', 'b', `return ${test}`)(r, g, b);
  }, test, { timeout: 45000 });
  const cameraOn = async () => {
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Turn camera on', exact: true }).click();
    await page.getByRole('button', { name: 'Turn camera off', exact: true }).waitFor({ timeout: 45000 });
    await page.getByRole('button', { name: 'Camera background', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.background-preview video')?.srcObject?.getVideoTracks()[0]?.readyState === 'live');
    assert(await page.evaluate(() => document.querySelector('.background-preview video').srcObject.getVideoTracks()[0].id !== window.__captures.at(-1).getVideoTracks()[0].id), 'The remembered background processes the new camera');
  };
  const leave = async () => {
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Leave office', exact: true }).click();
    await page.getByRole('button', { name: 'Enter the office', exact: true }).waitFor();
  };
  // The last choice made was the red custom image.
  await revisit();
  await pressed('custom').waitFor();
  await cameraOn();
  await cornerPixel('r > 230 && g < 25 && b < 25');
  await page.getByRole('button', { name: 'Blur', exact: true }).click();
  await pressed('Blur').waitFor({ timeout: 45000 });
  await leave();
  await revisit();
  await pressed('Blur').waitFor();
  await cameraOn();
  await page.getByRole('button', { name: 'Sky', exact: true }).click();
  await pressed('Sky').waitFor({ timeout: 45000 });
  await leave();
  await revisit();
  await pressed('Sky').waitFor();
  await cameraOn();
  await cornerPixel('b > r');
  console.log('Blur, a built-in scene and a custom image survive a reload and apply to a newly enabled camera.');
  // A remembered custom background whose image is gone or unreadable becomes Blur, never None.
  await page.getByLabel('Background image', { exact: true }).setInputFiles({ name: 'custom.png', mimeType: 'image/png', buffer: await page.evaluate(async () => { const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 20; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 20, 20); return [...new Uint8Array(await (await new Promise((resolve) => canvas.toBlob(resolve))).arrayBuffer())]; }).then((bytes) => Buffer.from(bytes)) });
  await pressed('custom').waitFor({ timeout: 45000 });
  await leave();
  await page.evaluate(() => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('bespingle'); request.onsuccess = resolve; request.onerror = reject; request.onblocked = reject; }));
  await revisit();
  await pressed('Blur').waitFor();
  await cameraOn();
  await leave();
  await page.evaluate(() => { localStorage.setItem('bespingle_camera_background', 'custom'); });
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('bespingle', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('backgrounds');
    open.onsuccess = () => { const tx = open.result.transaction('backgrounds', 'readwrite'); tx.objectStore('backgrounds').put('not an image', 'custom'); tx.oncomplete = () => { open.result.close(); resolve(); }; tx.onerror = reject; };
    open.onerror = reject;
  }));
  await revisit();
  await pressed('Blur').waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  // Without IndexedDB at all, the same.
  const bare = await context.newPage();
  await bare.addInitScript(() => { delete window.indexedDB; });
  await bare.goto(url);
  await bare.getByLabel('Your display name').fill('No IndexedDB');
  await bare.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await bare.getByRole('button', { name: 'Camera background', exact: true }).click();
  await bare.getByRole('button', { name: 'Blur', exact: true }).and(bare.locator('[aria-pressed="true"]')).waitFor();
  await bare.close();
  console.log('A remembered custom background with its image missing, unreadable, or without IndexedDB falls back to Blur.');
  console.log('Camera backgrounds passed: real MediaPipe inference, presets, custom images, live switching, camera reuse, processed peer video, startup/runtime failures, cleanup, and remembered choices.');
} finally { await browser.close(); }
await import('./background-rungs-smoke.mjs');
