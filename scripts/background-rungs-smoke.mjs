// Browser checks for camera background rungs in src/cameraBackground.ts, run by test:backgrounds.
// Each lower rung must segment less, while the output track keeps its object, size and background.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const origin = new URL(process.env.BESPINGLE_URL || 'http://127.0.0.1:5555').origin;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ permissions: ['camera'] });
  await context.addInitScript(() => {
    // Every frame sent for segmentation, with its size.
    window.__segmented = [];
    window.__workers = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); window.__workers.push(this); }
      postMessage(message, ...rest) {
        if (message?.type === 'frame') window.__segmented.push({ at: performance.now(), width: message.frame.width, height: message.frame.height });
        return super.postMessage(message, ...rest);
      }
      terminate() { this.terminated = true; super.terminate(); }
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/audio/NOTICE.txt`); // A quiet page, so CPU readings are the effect's.
  const cdp = await browser.newBrowserCDPSession();
  const cpu = async () => (await cdp.send('SystemInfo.getProcessInfo')).processInfo.reduce((sum, process) => sum + process.cpuTime, 0);

  await page.evaluate(async () => {
    window.__camera = (await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })).getVideoTracks()[0];
    const video = document.createElement('video');
    video.muted = true; video.srcObject = new MediaStream([window.__camera]); await video.play();
    window.__plain = video;
  });
  await page.waitForTimeout(1000);
  const before = await cpu(); await page.waitForTimeout(4000);
  const baseline = ((await cpu()) - before) / 4 * 100;
  const { rungs, size } = await page.evaluate(async () => {
    const { createCameraBackground, CAMERA_RUNGS } = await import('/src/cameraBackground.ts');
    window.__plain.pause(); window.__plain.srcObject = null;
    window.__failures = [];
    window.__processor = await createCameraBackground(window.__camera, 'sky', (message) => window.__failures.push(message));
    window.__track = window.__processor.track;
    const video = document.createElement('video');
    video.muted = true; video.srcObject = new MediaStream([window.__track]); await video.play();
    window.__video = video;
    window.__delivered = 0;
    const count = () => { window.__delivered++; video.requestVideoFrameCallback(count); };
    video.requestVideoFrameCallback(count);
    return { rungs: CAMERA_RUNGS.length, size: window.__track.getSettings() };
  });
  assert(rungs >= 2, `The module exposes its rungs: ${rungs}`);

  // A rung's segmentation rate, segmented frame, delivered output and background, over a few seconds.
  const measure = async (rung) => {
    await page.evaluate((rung) => window.__processor.setRung(rung), rung);
    await page.waitForTimeout(1000); // Lets the frame in flight at the change come back.
    const start = await page.evaluate(() => ({ at: performance.now(), delivered: window.__delivered }));
    const before = await cpu();
    await page.waitForTimeout(4000);
    const used = (await cpu()) - before;
    return page.evaluate(({ rung, start, used }) => {
      const now = performance.now(); const seconds = (now - start.at) / 1000;
      const frames = window.__segmented.filter(({ at }) => at >= start.at);
      const video = window.__video;
      const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
      const settings = window.__track.getSettings();
      return {
        rung, rate: frames.length / seconds, sizes: [...new Set(frames.map(({ width, height }) => `${width}x${height}`))],
        pixels: frames.length ? frames[0].width * frames[0].height : 0,
        delivered: (window.__delivered - start.delivered) / seconds, cpu: used / seconds * 100,
        output: `${settings.width}x${settings.height}`, shown: `${video.videoWidth}x${video.videoHeight}`,
        pixel: [...ctx.getImageData(5, 5, 1, 1).data],
      };
    }, { rung, start, used });
  };
  const ladder = [];
  for (let rung = 0; rung < rungs; rung++) ladder.push(await measure(rung));
  for (let rung = rungs - 2; rung >= 0; rung--) ladder.push(await measure(rung));
  for (const step of ladder) console.log(`MEASURED: rung ${step.rung}: ${step.rate.toFixed(1)} segmentations/s of ${step.sizes.join(', ')} (${(step.rate * step.pixels / 1e6).toFixed(2)} Mpx/s), output ${step.output} at ${step.delivered.toFixed(1)} fps, browser CPU ${step.cpu.toFixed(0)}% of one core (effect ≈ ${(step.cpu - baseline).toFixed(0)}% over ${baseline.toFixed(0)}% with the plain camera playing)`);

  const state = await page.evaluate(() => ({
    same: window.__processor.track === window.__track, live: window.__track.readyState, camera: window.__camera.readyState,
    workers: window.__workers.length, terminated: window.__workers.filter((worker) => worker.terminated).length, failures: window.__failures,
  }));
  assert.deepEqual(state, { same: true, live: 'live', camera: 'live', workers: 1, terminated: 0, failures: [] }, 'Changing rung keeps the worker, the camera and the output track');
  for (const step of ladder) {
    assert.equal(step.sizes.length, 1, `Rung ${step.rung} segments one frame size: ${step.sizes}`);
    assert.equal(step.output, `${size.width}x${size.height}`, `Rung ${step.rung} keeps the output size`);
    assert.equal(step.shown, `${size.width}x${size.height}`, `Rung ${step.rung} shows frames at the output size`);
    assert(step.delivered >= 3, `Rung ${step.rung} keeps delivering frames: ${step.delivered.toFixed(1)} fps`);
    assert(step.pixel[2] > step.pixel[0] + 40, `Rung ${step.rung} still draws the sky: ${step.pixel}`);
  }
  assert.equal(ladder[0].sizes[0], '960x540', 'Rung 0 segments the full 960-pixel frame');
  assert(ladder[0].rate > 10, `Rung 0 runs at about 20 segmentations a second: ${ladder[0].rate.toFixed(1)}`);
  for (let rung = 1; rung < rungs; rung++) {
    const above = ladder[rung - 1]; const below = ladder[rung];
    assert(below.rate < above.rate * 0.85, `Rung ${rung} segments less often than rung ${rung - 1}: ${below.rate.toFixed(1)} vs ${above.rate.toFixed(1)}`);
    assert(below.pixels <= above.pixels, `Rung ${rung} segments no larger a frame than rung ${rung - 1}`);
  }
  const back = ladder.at(-1);
  assert.equal(back.sizes[0], ladder[0].sizes[0], 'Moving back up restores the full frame');
  assert(back.rate > ladder[1].rate, `Moving back up restores the rate: ${back.rate.toFixed(1)}`);
  console.log(`PASS: each lower rung segments less (${ladder.slice(0, rungs).map((step) => `${step.rate.toFixed(1)}/s at ${step.sizes[0]}`).join(', ')}), and down and back up the output stays one live ${size.width}x${size.height} track with the sky drawn, on the same worker and camera`);

  // Starting at a low rung never segments at full cost.
  const started = await page.evaluate(async (rung) => {
    window.__processor.stop();
    const { createCameraBackground } = await import('/src/cameraBackground.ts');
    window.__segmented.length = 0;
    const processor = await createCameraBackground(window.__camera, 'blur', () => {}, undefined, undefined, { rung });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = { sizes: [...new Set(window.__segmented.map(({ width, height }) => `${width}x${height}`))], output: `${processor.track.getSettings().width}x${processor.track.getSettings().height}` };
    processor.stop(); window.__camera.stop();
    return result;
  }, rungs - 1);
  assert.deepEqual(started.sizes, [ladder[rungs - 1].sizes[0]], `A processor started at rung ${rungs - 1} segments only its frame size`);
  assert.equal(started.output, `${size.width}x${size.height}`, 'A processor started low still produces the full output size');
  console.log(`PASS: a processor started at rung ${rungs - 1} segments only ${started.sizes[0]} frames and outputs ${started.output}`);
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
