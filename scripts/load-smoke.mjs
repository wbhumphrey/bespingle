import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

// The stepper and the ladder are plain code, so their timing is checked here
// on a simulated clock before the browser check drives the real thing.
const bundle = await build({
  stdin: { contents: "export * from './src/loadSteps.ts'; export * from './src/videoQuality.ts';", resolveDir: new URL('..', import.meta.url).pathname, loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
});
const { LoadStepper, downHold, upHold, settle, qualityTarget, loadHeadroom, carrySteps } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function run(stepper, level, from, to, headroom = 4) {
  const changes = [];
  for (let now = from; now <= to; now += 250) {
    const before = stepper.steps;
    if (stepper.update(level(now), now, headroom) !== before) changes.push({ now, steps: stepper.steps });
  }
  return changes;
}
{
  const stepper = new LoadStepper();
  const down = run(stepper, () => 'heavy', 0, 60_000);
  assert.deepEqual(down.map(({ steps }) => steps), [1, 2, 3, 4], 'Heavy load walks down one rung at a time to the headroom');
  assert.deepEqual(down.map(({ now }) => now), [0, 1, 2, 3].map((n) => downHold + n * (settle + downHold)), 'One step down per hold, each after the last one settles');
  // Heavy load that the first step relieved goes no further.
  const burst = new LoadStepper();
  run(burst, (now) => now < downHold + settle - 1000 ? 'heavy' : 'normal', 0, downHold + settle + 2 * downHold);
  assert.equal(burst.steps, 1, 'A burst relieved by one step down stops there');
  const up = run(stepper, () => 'normal', 60_000, 200_000);
  assert.deepEqual(up.map(({ steps }) => steps), [3, 2, 1, 0], 'Normal load walks back up one rung at a time');
  assert.deepEqual(up.map(({ now }) => now - 60_000), [1, 2, 3, 4].map((n) => n * upHold), 'One step up per hold');
  assert.deepEqual(run(stepper, () => 'elevated', 200_000, 400_000), [], 'Elevated load moves nothing');
  // Flapping faster than either hold leaves quality where it is, from the top and from below.
  const flap = (now) => Math.floor(now / 3000) % 2 ? 'heavy' : 'normal';
  assert.deepEqual(run(new LoadStepper(), flap, 0, 300_000), [], 'Flapping does not step down');
  const lowered = new LoadStepper();
  run(lowered, () => 'heavy', 0, 2 * downHold + settle);
  assert.equal(lowered.steps, 2);
  assert.deepEqual(run(lowered, flap, 20_000, 300_000), [], 'Flapping does not step up');
  // A step up that brings the load straight back makes the next one wait longer.
  const probing = new LoadStepper();
  run(probing, () => 'heavy', 0, downHold);
  run(probing, () => 'normal', 10_000, 10_000 + upHold);
  assert.equal(probing.steps, 0);
  run(probing, () => 'heavy', 30_250, 30_250 + downHold);
  assert.equal(probing.steps, 1);
  const retry = run(probing, () => 'normal', 40_000, 200_000);
  assert.deepEqual(retry, [{ now: 40_000 + 2 * upHold, steps: 0 }], 'A failed step up doubles the next hold');
  // Headroom of zero, as under a manual setting, ends a step-down at once.
  assert.equal(lowered.update('heavy', 400_000, 0), 0);
}
{
  const off = { sharing: false, background: false, noise: false };
  const all = { sharing: true, background: true, noise: true };
  const fps = (target) => [target.camera.cap?.frameRate, target.screen.cap?.frameRate];
  const ladder = [0, 1, 2, 3, 4].map((loadSteps) => fps(qualityTarget({ participants: 3, quality: 'auto', loadSteps, ...off, sharing: true })));
  assert.deepEqual(ladder, [[30, undefined], [24, undefined], [15, undefined], [15, 8], [15, 5]], 'Screen share is lowered only below the lowest camera rung');
  assert.equal(loadHeadroom({ participants: 3, quality: 'auto', ...off, sharing: true }), 4);
  assert.equal(loadHeadroom({ participants: 3, quality: 'auto', ...off }), 2, 'Screen rungs count only while sharing');
  assert.equal(loadHeadroom({ participants: 6, quality: 'auto', ...off }), 0);
  for (const quality of ['high', 'low', 'audio']) assert.equal(loadHeadroom({ participants: 3, quality, ...all }), 0, `${quality} ignores load`);

  // Each step as [camera fps, background rung, noise ceiling, screen fps].
  const state = (target) => [target.camera.cap?.frameRate, target.background, target.noise, target.screen.cap?.frameRate ?? null];
  const walk = (input, steps) => Array.from({ length: steps + 1 }, (_, loadSteps) => state(qualityTarget({ ...input, loadSteps })));
  const full = { participants: 3, quality: 'auto', ...all };
  assert.equal(loadHeadroom(full), 7, 'Two background rungs and one noise rung join the five video rungs');
  assert.deepEqual(walk(full, 7), [
    [30, 0, 'strong', null], [24, 0, 'strong', null], [15, 0, 'strong', null],
    [15, 1, 'strong', null], [15, 2, 'strong', null], [15, 2, 'standard', null],
    [15, 2, 'standard', 8], [15, 2, 'standard', 5],
  ], 'Camera, then the background one rung at a time, then noise, then screen share');
  const noBackground = { ...full, background: false };
  assert.equal(loadHeadroom(noBackground), 5, 'Background rungs count only while a background runs');
  assert.deepEqual(walk(noBackground, 3).at(-1), [15, 0, 'standard', null], 'With no background, noise steps down straight after the camera');
  assert.equal(loadHeadroom({ ...full, sharing: false, noise: false }), 4, 'The noise rung counts only while Strong runs');
  assert.equal(loadHeadroom({ ...full, participants: 6, sharing: false }), 3, 'A crowded carpet starts at the lowest camera rung, with the filter rungs below');
  for (const quality of ['high', 'low', 'audio']) {
    const target = qualityTarget({ ...full, quality, loadSteps: 7 });
    assert.deepEqual([target.background, target.noise], [0, 'strong'], `${quality} runs the filters as chosen whatever the load`);
  }

  // A section that joins or leaves mid-step-down leaves every other section as it was.
  const at = (input, loadSteps) => state(qualityTarget({ ...input, loadSteps }));
  const carried = (steps, from, to) => at(to, Math.min(carrySteps(steps, from, to), loadHeadroom(to)));
  assert.deepEqual(carried(3, noBackground, full), [15, 2, 'standard', null], 'A background turned on below a stepped-down noise rung starts at its lowest rung');
  assert.deepEqual(carried(2, noBackground, full), [15, 0, 'strong', null], 'A background turned on above any filter step-down starts at full quality');
  assert.deepEqual(carried(4, full, noBackground), [15, 0, 'strong', null], 'Turning the background off gives back its steps, and nothing else moves');
  assert.deepEqual(carried(6, full, noBackground), [15, 0, 'standard', 8], 'Turning the background off never lowers the screen share');
  assert.deepEqual(carried(4, { ...full, noise: false }, full), [15, 2, 'strong', null], 'Strong turned on with only the background stepped down starts at Strong');
  assert.deepEqual(carried(6, full, { ...full, noise: false }), [15, 2, 'strong', 8], 'A filter that fails gives back only its own step');
  assert.deepEqual(carried(5, { ...full, sharing: false }, full), [15, 2, 'standard', null], 'A share started under load starts uncapped');
  assert.equal(carrySteps(5, full, full), 5, 'An unchanged ladder keeps its steps');

  // The stepper on the simulated clock walks the whole ladder in order, then back in reverse.
  const stepper = new LoadStepper();
  const down = run(stepper, () => 'heavy', 0, 7 * (downHold + settle), 7).map(({ steps }) => at(full, steps));
  assert.deepEqual(down, walk(full, 7).slice(1), 'Sustained heavy load takes every rung once, in order');
  const up = run(stepper, () => 'normal', 200_000, 200_000 + 7 * upHold, 7).map(({ steps }) => at(full, steps));
  assert.deepEqual(up, walk(full, 6).reverse(), 'Sustained normal load gives them back in reverse: screen, noise, background, camera');
  console.log('Stepper: one rung per hold each way, flapping and elevated load hold still, failed step-ups back off');
  console.log('Policy: camera, background, noise, then screen share, counting only rungs that change something');
}

const world = JSON.parse(await readFile(new URL('../server/world.json', import.meta.url), 'utf8'));
const { size: tileSize, originX, originY } = world.grid;
const snap = (value, origin) => origin + Math.round((value - origin) / tileSize) * tileSize;
const url = process.env.BESPINGLE_URL || 'http://127.0.0.1:5555';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=fps=30', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const errors = [];
const pages = [];

// Both load signals are scripted: a fake PressureObserver, absent for a client
// standing in for Firefox or Safari, and the encoders' quality-limitation
// reason, which otherwise reports whatever this test machine is doing. The
// encoder's target bitrate sits at the sender's cap unless a test lowers it.
async function client(name, { pressure, builtIn = true }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] });
  await context.addInitScript(({ pressure, builtIn }) => {
    window.__pcs = [];
    window.__negotiations = 0;
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(...args) { super(...args); window.__pcs.push(this); }
      createOffer(...args) { window.__negotiations += 1; return super.createOffer(...args); }
      createAnswer(...args) { window.__negotiations += 1; return super.createAnswer(...args); }
    };
    window.__limit = 'none';
    window.__target = null;
    const getStats = RTCRtpSender.prototype.getStats;
    RTCRtpSender.prototype.getStats = async function (...args) {
      const report = await getStats.apply(this, args);
      const cap = this.getParameters().encodings?.[0]?.maxBitrate;
      return new Map([...report].map(([id, row]) => {
        if (row.type !== 'outbound-rtp' || row.kind !== 'video') return [id, row];
        const { qualityLimitationDurations: _, ...rest } = row;
        return [id, { ...rest, qualityLimitationReason: window.__limit, targetBitrate: window.__target ?? cap ?? row.targetBitrate }];
      }));
    };
    // The filters' rungs as they run: the width of each frame sent for
    // segmentation, and whether the noise filter passes the microphone through.
    window.__segment = null;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...rest) {
        if (message?.type === 'frame') window.__segment = message.frame.width;
        return super.postMessage(message, ...rest);
      }
    };
    window.__bypassed = null;
    window.__startedBypassed = [];
    const NativeNode = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context, name, options) {
        super(context, name, options);
        if (name !== 'rnnoise') return;
        window.__bypassed = !!options?.processorOptions?.bypassed;
        window.__startedBypassed.push(window.__bypassed);
        const port = this.port;
        const post = port.postMessage.bind(port);
        port.postMessage = (message, ...rest) => {
          if (message?.type === 'bypass') window.__bypassed = message.bypassed;
          return post(message, ...rest);
        };
      }
    };
    delete window.PressureObserver;
    // A browser without built-in noise suppression, where Strong's filter works alone.
    if (!builtIn) navigator.mediaDevices.getSupportedConstraints = () => ({});
    if (pressure) {
      const observers = new Set();
      window.__pressure = (state) => { for (const callback of observers) callback([{ source: 'cpu', state, time: performance.now() }]); };
      window.PressureObserver = class {
        constructor(callback) { this.callback = callback; }
        async observe() { observers.add(this.callback); }
        disconnect() { observers.delete(this.callback); }
      };
    }
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(15);
      const timer = setInterval(() => {
        if (stream.getTracks().every((track) => track.readyState === 'ended')) clearInterval(timer);
        ctx.fillStyle = '#113c52'; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = 'white'; ctx.font = '48px sans-serif'; ctx.fillText(`Shared ${Date.now()}`, 40, 100);
      }, 66);
      return stream;
    };
  }, { pressure, builtIn });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error') console.log(name, message.type(), message.text()); });
  await page.goto(url);
  await page.getByLabel('Your display name').fill(name);
  await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  pages.push(page);
  return page;
}

async function position(page) {
  return page.locator('[data-testid="game-canvas"]').evaluate((canvas) => ({ x: Number(canvas.dataset.x), y: Number(canvas.dataset.y) }));
}
async function axis(page, target, coordinate) {
  target = snap(target, coordinate === 'x' ? originX : originY);
  for (let steps = 0; steps < 30; steps++) {
    const start = await position(page);
    if (start[coordinate] === target) return;
    const positive = target > start[coordinate];
    const key = coordinate === 'x' ? positive ? 'd' : 'a' : positive ? 's' : 'w';
    const destination = start[coordinate] + (positive ? tileSize : -tileSize);
    await page.keyboard.down(key);
    await page.waitForTimeout(35);
    await page.keyboard.up(key);
    await page.waitForFunction(({ coordinate, destination }) => {
      const canvas = document.querySelector('[data-testid="game-canvas"]');
      return Number(canvas.dataset[coordinate]) === destination && canvas.dataset.moving !== 'true';
    }, { coordinate, destination }, { timeout: 2500 });
  }
  throw new Error(`Navigation did not reach ${coordinate}=${target}`);
}
async function go(page, x, y) {
  await page.bringToFront();
  await page.locator('[data-testid="game-canvas"]').focus();
  await axis(page, x, 'x');
  await axis(page, y, 'y');
}
async function enter(page, lane, background) {
  await go(page, lane, 696);
  await page.bringToFront();
  await page.locator('[data-testid="game-canvas"]').focus();
  await page.keyboard.down('w');
  await page.getByRole('dialog').waitFor();
  await page.keyboard.up('w');
  if (await page.getByRole('button', { name: 'Both', exact: false }).count()) {
    if (background) {
      await page.getByRole('button', { name: background, exact: true }).click();
      await page.getByRole('button', { name: background, exact: true, pressed: true }).waitFor({ timeout: 45_000 });
    }
    await page.getByRole('button', { name: 'Both', exact: false }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 60_000 });
  }
}

// The single connection's camera and screen frame-rate caps, or null when
// uncapped, with the segmented frame's width and whether noise is bypassed.
function caps(page) {
  return page.evaluate(() => {
    const pc = window.__pcs.find((item) => item.connectionState === 'connected');
    if (!pc) return null;
    const [, camera, screen] = pc.getTransceivers().map((transceiver) => transceiver.sender.getParameters().encodings?.[0]);
    return { camera: camera?.maxFramerate ?? null, screen: screen?.maxFramerate ?? null, segment: window.__segment, bypassed: window.__bypassed };
  });
}
async function expectCaps(page, want, timeout = 30_000) {
  const started = Date.now();
  for (;;) {
    const seen = await caps(page);
    if (seen && Object.keys(want).every((key) => seen[key] === want[key])) return Date.now() - started;
    if (Date.now() - started > timeout) throw new Error(`Expected ${JSON.stringify(want)}, saw ${JSON.stringify(seen)}`);
    await page.waitForTimeout(200);
  }
}
// Samples caps for a while and returns every distinct state in order.
async function watch(page, ms) {
  const states = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const seen = JSON.stringify(await caps(page));
    if (states.at(-1) !== seen) states.push(seen);
    await page.waitForTimeout(200);
  }
  return states.map((state) => JSON.parse(state));
}
const pressure = (page, state) => page.evaluate((state) => window.__pressure(state), state);
const limit = (page, reason, target = null) => page.evaluate(({ reason, target }) => { window.__limit = reason; window.__target = target; }, { reason, target });
const negotiations = (list) => Promise.all(list.map((page) => page.evaluate(() => window.__negotiations)));
const sent = (page, slot) => page.evaluate(async (slot) => {
  const pc = window.__pcs.find((item) => item.connectionState === 'connected');
  const sender = pc.getTransceivers()[slot].sender;
  const row = [...(await sender.getStats()).values()].find((item) => item.type === 'outbound-rtp');
  return { track: sender.track?.id, bytes: row?.bytesSent ?? 0, frames: row?.framesEncoded ?? 0 };
}, slot);
const audio = (page) => sent(page, 0);
const camera = (page) => sent(page, 1);
// The reduced note beside each filter's control, the choices as settings show
// them, and the microphone's status line.
async function filterSettings(page) {
  await page.bringToFront();
  await page.getByRole('button', { name: 'Microphone settings', exact: true }).click();
  const microphone = {
    note: await page.locator('.noise-levels .reduced-note').textContent(),
    strong: await page.getByRole('radio', { name: 'Strong', exact: true }).isChecked(),
    status: await page.locator('.noise-levels + .media-note').textContent(),
  };
  await page.getByRole('button', { name: 'Done', exact: false }).click();
  await page.getByRole('button', { name: 'Camera background', exact: true }).click();
  const background = {
    note: await page.locator('.background-settings .reduced-note').textContent(),
    sky: await page.getByRole('button', { name: 'Sky', exact: true }).getAttribute('aria-pressed'),
  };
  await page.getByRole('button', { name: 'Done', exact: false }).click();
  return { microphone, background };
}
async function chooseQuality(page, label) {
  await page.bringToFront();
  await page.getByRole('button', { name: 'Video settings', exact: true }).click();
  await page.getByRole('radio', { name: label, exact: true }).check();
  await page.getByRole('button', { name: 'Done', exact: false }).click();
}

try {
  // Alice runs a sky background and Strong noise filtering, and shares her
  // screen, so her ladder holds every section: seven rungs below 720p30.
  const alice = await client('Alice', { pressure: true });
  await enter(alice, 648, 'Sky');
  const bob = await client('Bob', { pressure: false, builtIn: false });
  await enter(bob, 600);
  await alice.bringToFront();
  await alice.getByRole('button', { name: 'Share screen', exact: true }).click();
  await bob.locator('[data-testid="screen-peer"] video').waitFor();
  // Each segmented frame is one rung's width, or the camera's if narrower.
  const widths = await alice.evaluate(async () => {
    const { CAMERA_RUNGS } = await import('/src/cameraBackground.ts');
    const width = window.__pcs.find((item) => item.connectionState === 'connected')?.getTransceivers()[1].sender.track?.getSettings().width;
    return CAMERA_RUNGS.map((rung) => Math.min(rung.width, width ?? rung.width));
  });
  assert.equal(new Set(widths).size, 3, `Each background rung segments a different width: ${widths}`);
  const full = { camera: 30, screen: null, segment: widths[0], bypassed: false };
  await expectCaps(alice, full);
  await expectCaps(bob, { camera: 30, screen: null });
  assert.equal(await bob.evaluate(() => 'PressureObserver' in window), false, 'Bob stands in for a browser without the Compute Pressure API');

  // Normal pressure and unlimited encoders: two people stay at full quality.
  // An encoder held at the policy's own bitrate cap reports a bandwidth limit
  // for as long as the cap stands. That is not load.
  await pressure(alice, 'nominal');
  await limit(bob, 'bandwidth');
  const [quiet, capped] = await Promise.all([watch(alice, 8000), watch(bob, 8000)]);
  assert.deepEqual(quiet, [full], 'No load changes nothing');
  assert.deepEqual(capped.map(({ camera, screen }) => ({ camera, screen })), [{ camera: 30, screen: null }], 'A bandwidth limit at our own bitrate cap is not load');
  await limit(bob, 'none');
  // A signal flapping faster than the hold leaves quality alone.
  for (let flip = 0; flip < 6; flip++) {
    await pressure(alice, flip % 2 ? 'nominal' : 'critical');
    await alice.waitForTimeout(2500);
  }
  await pressure(alice, 'nominal');
  assert.deepEqual(await caps(alice), full, 'Flapping pressure leaves quality where it is');
  console.log('No load and flapping load leave two people at 720p30 with the screen uncapped');

  // Sustained heavy pressure walks the camera down, then the background, then
  // noise filtering, then the screen share.
  const before = await negotiations([alice, bob]);
  const audioBefore = await audio(alice);
  const cameraBefore = await camera(alice);
  const unreduced = await filterSettings(alice);
  assert.deepEqual([unreduced.microphone.note, unreduced.background.note], ['', ''], 'No reduced note at normal load');
  const ladder = [
    full, { ...full, camera: 24 }, { ...full, camera: 15 },
    { ...full, camera: 15, segment: widths[1] }, { ...full, camera: 15, segment: widths[2] },
    { ...full, camera: 15, segment: widths[2], bypassed: true },
    { camera: 15, screen: 8, segment: widths[2], bypassed: true }, { camera: 15, screen: 5, segment: widths[2], bypassed: true },
  ];
  await pressure(alice, 'serious');
  // The segmenter's load makes timers drift, so the watch runs on past the last step.
  const down = await watch(alice, 5000 + 6 * (10_000 + 5000) + 15_000);
  assert.deepEqual(down, ladder, `Heavy load steps the camera, then the background, then noise, then the screen share: ${JSON.stringify(down)}`);
  console.log(`Heavy pressure steps 720p30 → 540p24 → 360p15, the background's segmentation ${widths.join(' → ')} px, Strong noise filtering to Standard, then the screen share to 8 and 5 fps`);

  const reduced = await filterSettings(alice);
  assert.deepEqual(reduced.microphone.note, 'Reduced to keep the call smooth.', 'A note beside the noise level while it is held down');
  assert.deepEqual(reduced.background.note, 'Reduced to keep the call smooth.', 'A note beside the background choices while it is held down');
  assert(reduced.microphone.strong && reduced.background.sky === 'true', `The choices read back unchanged: ${JSON.stringify(reduced)}`);
  assert(!reduced.microphone.status.includes('Strong noise filtering is active'), `The status does not claim Strong while it is bypassed: ${reduced.microphone.status}`);
  console.log('Settings show Strong and Sky still chosen, each with a reduced note');

  // Bob has only the encoder's report. A CPU limit steps him down, and so
  // does a bandwidth limit well below the cap, which the network imposes.
  await limit(bob, 'cpu');
  const bobDown = await expectCaps(bob, { camera: 24, screen: null }, 15_000);
  await limit(bob, 'bandwidth', 150_000);
  const bobFurther = await expectCaps(bob, { camera: 15, screen: null }, 30_000);
  console.log(`Without PressureObserver, encoder reports step the camera down: CPU limit (${bobDown} ms), then a network bandwidth limit (${bobFurther} ms)`);
  // Bob's browser has no built-in suppression, so bypassing Strong would leave
  // his microphone unsuppressed. Sustained load goes no further than the camera.
  await bob.waitForTimeout(5000 + 10_000 + 5000);
  assert.deepEqual(await caps(bob), { camera: 15, screen: null, segment: null, bypassed: false }, 'Without built-in suppression, load never bypasses Strong');
  console.log('Without built-in suppression, sustained load leaves Strong noise filtering running');
  // Nor does a filter started under that load begin bypassed, even for a moment. With a section
  // below noise stepped down too, a noise section that counted would join at its lowest rung, so
  // Bob shares his screen and lets the load reach it first.
  await bob.getByRole('button', { name: 'Share screen', exact: true }).click();
  await expectCaps(bob, { camera: 15, screen: 5 }, 45_000);
  const startedBefore = await bob.evaluate(() => window.__startedBypassed.length);
  await bob.getByRole('button', { name: 'Microphone settings', exact: true }).click();
  // Each change settles, with the levels enabled again, before the next.
  const settled = (level) => bob.waitForFunction((value) => !document.querySelector('.noise-levels')?.disabled && document.querySelector('.noise-levels input:checked')?.value === value, level);
  await bob.getByRole('radio', { name: 'Off', exact: true }).click();
  await settled('off');
  await bob.getByRole('radio', { name: 'Strong', exact: true }).click();
  await settled('strong');
  await bob.waitForFunction((count) => window.__startedBypassed.length > count, startedBefore);
  await bob.getByRole('button', { name: 'Done', exact: false }).click();
  const started = await bob.evaluate(() => window.__startedBypassed);
  assert.deepEqual(started, started.map(() => false), `Without built-in suppression, Strong started under load starts unbypassed: ${JSON.stringify(started)}`);
  assert.deepEqual(await caps(bob), { camera: 15, screen: 5, segment: null, bypassed: false }, 'Strong restarted under load stays unbypassed');
  await bob.getByRole('button', { name: 'Stop sharing screen', exact: true }).click();
  await expectCaps(bob, { camera: 15, screen: null }, 10_000);
  console.log('Without built-in suppression, Strong started under load starts unbypassed, even with the screen share stepped down');

  // Recovery restores the screen share first, then the camera, one hold each.
  await pressure(alice, 'nominal');
  await limit(bob, 'none');
  const up = await watch(alice, 7 * 20_000 + 15_000);
  assert.deepEqual(up, [...ladder].reverse(), `Recovery restores the screen share, then noise, then the background, then the camera: ${JSON.stringify(up)}`);
  await expectCaps(bob, { camera: 30, screen: null }, 10_000);
  console.log('Once load stays low, the rungs come back in reverse, one at a time');

  const restored = await filterSettings(alice);
  assert.deepEqual(restored, unreduced, `The notes clear on restore and the choices stand: ${JSON.stringify(restored)}`);
  const audioAfter = await audio(alice);
  const cameraAfter = await camera(alice);
  assert.equal(audioAfter.track, audioBefore.track, 'Load changes keep the same audio track');
  assert(audioAfter.bytes > audioBefore.bytes, 'Audio keeps flowing through load changes');
  assert.equal(cameraAfter.track, cameraBefore.track, 'Load changes keep the same camera track');
  assert(cameraAfter.frames > cameraBefore.frames, 'The camera keeps delivering frames through load changes');
  assert.deepEqual(await negotiations([alice, bob]), before, 'Load changes create no offer or answer');
  console.log('Load-driven changes keep audio and camera flowing on the same tracks and never renegotiate');

  // A manual setting restores filters that load stepped down, and then ignores load.
  await pressure(alice, 'serious');
  await expectCaps(alice, ladder[3], 5000 + 2 * (10_000 + 5000) + 6000);
  await chooseQuality(alice, 'High');
  await expectCaps(alice, full, 3000);
  await pressure(alice, 'critical');
  assert.deepEqual(await watch(alice, 8000), [full], 'High ignores heavy load');
  await pressure(alice, 'nominal');
  console.log('Choosing High while the background is stepped down restores it at once, and holds under load');

  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log('PASS: device load steps Auto quality and the background filters down and back in order with hold times, screen share last, without renegotiation');
} catch (error) {
  for (const [index, page] of pages.entries()) {
    await page.screenshot({ path: `test-results/load-failure-${index}.png` }).catch(() => {});
    console.log(`Client ${index}`, JSON.stringify(await caps(page).catch(() => null)));
  }
  throw error;
} finally {
  await browser.close();
}
