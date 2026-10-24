import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../test-results/audio/', import.meta.url));
await mkdir(output, { recursive: true });

// Run straight after `npm run dev`, the stack may still be starting: wait until the app and its office answer.
const app = process.env.BESPINGLE_URL || 'http://localhost:5555';
for (const deadline = Date.now() + 120000; ;) {
  try { if ((await fetch(new URL('/api/health', app))).ok) break; } catch { /* Not listening yet. */ }
  assert(Date.now() < deadline, `${app} did not answer within two minutes: is \`npm run dev\` running?`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] });
  await context.addInitScript(() => {
    window.__captures = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await capture(constraints);
      window.__captures.push({ constraints, stream });
      return stream;
    };
    // The noise filter runs in the only 48 kHz context; speaking detection uses the default rate.
    window.__filterContexts = [];
    const Native = window.AudioContext;
    if (Native) window.AudioContext = class extends Native { constructor(options) { super(options); if (options?.sampleRate === 48000) window.__filterContexts.push(this); } };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app);
  await page.getByLabel('Your display name').fill('Audio check');
  await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  // Stand on a carpet with devices off, so the self tile shows the published local stream.
  await page.locator('[data-testid="game-canvas"]').focus();
  await page.keyboard.down('w');
  await page.getByRole('dialog').waitFor();
  await page.keyboard.up('w');
  await page.getByRole('button', { name: 'Neither', exact: false }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  const settings = () => page.getByRole('button', { name: 'Microphone settings', exact: true }).click();
  const done = () => page.getByRole('button', { name: 'Done', exact: false }).click();
  const level = (name) => page.getByRole('radio', { name, exact: true });
  const settled = () => page.waitForFunction(() => [...document.querySelectorAll('.noise-level input')].some((input) => !input.closest('fieldset').disabled));
  // The radio follows the level in effect, so it only shows checked once a live change completes.
  const choose = async (name) => { await level(name).click(); await settled(); assert(await level(name).isChecked(), `${name} is selected`); };
  const micOn = async () => {
    await page.getByRole('button', { name: 'Turn microphone on', exact: true }).click();
    await page.getByRole('button', { name: 'Turn microphone off', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Turn microphone off"]').disabled);
    assert.equal(await page.getByRole('dialog').count(), 0, 'The mic button toggles the microphone without opening settings');
  };
  const micOff = async () => {
    await page.getByRole('button', { name: 'Turn microphone off', exact: true }).click();
    await page.getByRole('button', { name: 'Turn microphone on', exact: true }).waitFor();
  };
  const state = () => page.evaluate(() => window.__captures.map(({ constraints, stream }) => ({
    constraints, tracks: stream.getTracks().map((track) => ({ id: track.id, state: track.readyState, settings: track.getSettings() })),
  })));
  // The audio track the app publishes as its local stream, which is also what peers receive.
  const published = () => page.evaluate(() => {
    const track = document.querySelector('[data-testid="video-self"] video')?.srcObject?.getAudioTracks()[0];
    return track && { id: track.id, state: track.readyState };
  });
  const note = (text) => page.getByRole('status').filter({ hasText: text }).waitFor();

  // The mic button carries its settings: no separate Audio button, and a ⋯ reached by keyboard.
  const bar = page.locator('.media-controls');
  assert.equal(await bar.getByText('Audio', { exact: true }).count(), 0, 'The control bar has no Audio button');
  assert.equal(await bar.getByRole('button', { name: 'Microphone settings', exact: true }).count(), 1);
  await page.getByRole('group', { name: 'Microphone', exact: true }).screenshot({ path: `${output}/mic-off-control.png` });
  await bar.screenshot({ path: `${output}/control-bar-mic-off.png` });
  await page.getByRole('button', { name: 'Turn microphone on', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Microphone settings', 'The ⋯ follows the mic button in keyboard order');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Microphone settings', exact: true }).waitFor();
  await done();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  await settings();
  await page.getByRole('dialog', { name: 'Microphone settings', exact: true }).waitFor();
  assert.equal(await page.getByRole('radio').count(), 3, 'Microphone settings holds the three noise levels');
  assert.equal(await page.getByRole('group', { name: 'Video quality', exact: true }).count(), 0, 'Microphone settings holds no video quality');
  assert.equal(await page.getByText('Audio and video settings').count(), 0, 'Nothing is called Audio and video settings');
  assert(await level('Strong').isChecked(), 'The level defaults to Strong');
  await page.getByRole('dialog').screenshot({ path: `${output}/microphone-settings.png` });
  for (const name of ['Off', 'Strong', 'Off']) await choose(name);
  await note('Your microphone is off.');
  await done();
  assert.equal(await page.evaluate(() => window.__captures.length), 0, 'Choosing a level with the microphone off opens no capture');

  // Each level captures with its own built-in suppression constraint.
  await micOn();
  let captures = await state();
  assert.equal(captures[0].constraints.audio.noiseSuppression, false, 'Off captures without built-in suppression');
  assert.equal(captures[0].tracks[0].settings.noiseSuppression, false);
  assert.equal(captures[0].tracks[0].settings.echoCancellation, true);
  assert.equal((await published()).id, captures[0].tracks[0].id, 'Off publishes the raw microphone');
  await micOff();
  await settings(); await choose('Standard'); await done();
  await micOn();
  captures = await state();
  assert.equal(captures[1].constraints.audio.noiseSuppression, true, 'Standard captures with built-in suppression');
  assert.equal((await published()).id, captures[1].tracks[0].id, 'Standard publishes the raw microphone');
  await micOff();
  await settings(); await choose('Strong'); await done();
  await micOn();
  captures = await state();
  assert.equal(captures.length, 3);
  assert.equal(captures[2].constraints.audio.noiseSuppression, true, 'Strong captures with built-in suppression');
  const raw = captures[2].tracks[0].id;
  await page.waitForFunction((raw) => document.querySelector('[data-testid="video-self"] video')?.srcObject?.getAudioTracks()[0]?.id !== raw, raw);
  assert.equal((await published()).state, 'live', 'Strong publishes the live filter output, not the raw capture track');
  assert.equal(await page.evaluate(() => window.__filterContexts.filter((item) => item.state === 'running').length), 1, 'One filter runs');
  // Chromium's fake microphone beeps loudly enough to count as speech through the filter.
  await page.locator('[data-testid="video-self"].is-speaking').waitFor({ timeout: 10000 });
  await page.getByRole('group', { name: 'Microphone', exact: true }).screenshot({ path: `${output}/mic-on-control.png` });
  await bar.screenshot({ path: `${output}/control-bar-mic-on.png` });

  // Live switching changes only the published track: no recapture and no new microphone.
  await settings();
  await note('Strong noise filtering is active');
  const live = async (name, filtered) => {
    await choose(name);
    const now = await state();
    assert.equal(now.length, 3, `Switching to ${name} does not recapture`);
    assert.equal(now[2].tracks[0].id, raw);
    assert.equal(now[2].tracks[0].state, 'live', `Switching to ${name} keeps the microphone live`);
    assert.equal(now[2].tracks[0].settings.echoCancellation, true);
    assert.equal(now[2].tracks[0].settings.autoGainControl, true);
    const track = await published();
    assert.equal(track.state, 'live');
    if (filtered) assert.notEqual(track.id, raw, `${name} publishes the filter output`);
    else assert.equal(track.id, raw, `${name} publishes the raw microphone`);
    return now[2].tracks[0].settings;
  };
  await live('Off', false);
  assert.equal(await page.evaluate(() => window.__filterContexts.filter((item) => item.state !== 'closed').length), 0, 'Leaving Strong stops the filter');
  const standard = await live('Standard', false);
  if (standard.noiseSuppression) await note('Standard noise suppression is active.');
  else await note('Turn your microphone off and on');
  await live('Strong', true);
  await live('Standard', false);
  await live('Strong', true);

  // A filter failing mid-call falls back to Standard on the raw track, never to silence.
  await page.evaluate(() => window.__filterContexts.at(-1).close());
  await page.getByRole('alert').filter({ hasText: 'Strong noise filtering stopped.' }).waitFor();
  assert(await level('Standard').isChecked(), 'A failed filter falls back to Standard');
  await page.waitForFunction((raw) => document.querySelector('[data-testid="video-self"] video')?.srcObject?.getAudioTracks()[0]?.id === raw, raw);
  assert.equal((await state()).length, 3);
  assert.equal((await state())[2].tracks[0].state, 'live', 'Fallback keeps the microphone live');

  // A filter that cannot start does the same.
  await page.route('**/*.wasm', (route) => route.abort());
  await level('Strong').click(); await settled();
  await page.getByRole('alert').filter({ hasText: 'Strong noise filtering stopped.' }).waitFor();
  assert(await level('Standard').isChecked(), 'A filter that cannot start falls back to Standard');
  assert.equal((await published()).id, raw);
  assert.equal((await state())[2].tracks[0].state, 'live');
  await page.unroute('**/*.wasm');
  await live('Strong', true);

  // A failed built-in change preserves capture and the previous level.
  await page.evaluate(() => {
    window.__captures[2].stream.getAudioTracks()[0].applyConstraints = async () => { throw new Error('Device busy'); };
  });
  await level('Off').click(); await settled();
  await page.getByRole('alert').filter({ hasText: 'Could not change noise suppression.' }).waitFor();
  assert(await level('Strong').isChecked());
  assert.equal((await state())[2].tracks[0].state, 'live');
  assert.notEqual((await published()).id, raw, 'A failed change leaves Strong running');
  await done();

  // Muting stops the filter without reporting a failure; re-enabling restores Strong.
  await micOff();
  await page.waitForFunction(() => window.__filterContexts.every((item) => item.state === 'closed'));
  assert.equal(await page.getByRole('alert').filter({ hasText: 'Strong noise filtering stopped.' }).count(), 0, 'Muting is not a filter failure');
  await micOn();
  captures = await state();
  assert.equal(captures.length, 4);
  assert.equal(captures[3].constraints.audio.noiseSuppression, true, 'Re-enabled mic keeps the level');
  await page.waitForFunction((raw) => { const track = document.querySelector('[data-testid="video-self"] video')?.srcObject?.getAudioTracks()[0]; return track && track.id !== raw && track.readyState === 'live'; }, captures[3].tracks[0].id);

  // Re-enabling at Standard applies suppression in browsers that cannot switch it live.
  await micOff();
  await settings(); await choose('Off'); await choose('Standard'); await done();
  await micOn();
  assert.equal((await state())[4].tracks[0].settings.noiseSuppression, true, 'Recapture applies suppression in browsers that cannot switch live');

  // A change overtaken by the microphone ending still stands, and leaves the control usable.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/*.wasm', async (route) => { await held; await route.continue(); });
  await settings();
  await level('Strong').click();
  await page.waitForFunction(() => document.querySelector('.noise-levels').disabled);
  await page.evaluate(() => window.__captures[4].stream.getAudioTracks()[0].stop());
  release();
  await settled();
  assert(await level('Strong').isChecked(), 'A level change overtaken by the microphone ending is recorded');
  await page.unroute('**/*.wasm');
  await page.waitForFunction(() => window.__filterContexts.every((item) => item.state === 'closed'));
  await done();
  await page.getByRole('button', { name: 'Leave office', exact: true }).click();
  await page.waitForFunction(() => window.__captures.every(({ stream }) => stream.getTracks().every((track) => track.readyState === 'ended')));
  await page.waitForFunction(() => window.__filterContexts.every((item) => item.state === 'closed'));

  // Each unsupported browser gets its own page, so one missing feature cannot mask another.
  const visit = async (name, init, arg) => {
    const current = await context.newPage();
    current.on('pageerror', (error) => errors.push(error.message));
    if (init) await current.addInitScript(init, arg);
    // Each stands in for another browser, so none inherits the last page's tile.
    await current.addInitScript(() => localStorage.removeItem('bespingle_session'));
    await current.goto(app);
    await current.getByLabel('Your display name').fill(name);
    await current.getByRole('button', { name: 'Enter the office', exact: true }).click();
    await current.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
    return current;
  };
  const enter = async (name, init, arg) => {
    const current = await visit(name, init, arg);
    await current.getByRole('button', { name: 'Microphone settings', exact: true }).click();
    return current;
  };
  const turnOn = async (current) => {
    await current.getByRole('button', { name: 'Turn microphone on', exact: true }).click();
    await current.getByRole('button', { name: 'Turn microphone off', exact: true }).waitFor();
    await current.waitForFunction(() => !document.querySelector('[aria-label="Turn microphone off"]').disabled);
  };

  // The very first mic-on of a fresh visit, with the settings never opened, reaches Strong.
  const fresh = await visit('Fresh visit');
  await turnOn(fresh);
  await fresh.waitForFunction(() => window.__filterContexts.some((item) => item.state === 'running'));
  const first = await fresh.evaluate(() => window.__captures.map(({ constraints }) => constraints.audio.noiseSuppression));
  assert.deepEqual(first, [true], 'The first mic-on captures with built-in suppression');
  assert.equal(await fresh.getByRole('alert').count(), 0, 'The first mic-on at Strong raises no alert');
  await fresh.getByRole('button', { name: 'Microphone settings', exact: true }).click();
  await fresh.getByRole('status').filter({ hasText: 'Strong noise filtering is active' }).waitFor();
  await fresh.getByRole('button', { name: 'Done', exact: false }).click();
  await fresh.getByRole('button', { name: 'Leave office', exact: true }).click();
  await fresh.close();

  // Browsers without built-in suppression still offer Strong, using the filter alone.
  const plain = await enter('No built-in suppression', () => { navigator.mediaDevices.getSupportedConstraints = () => ({}); });
  assert(await plain.getByRole('radio', { name: 'Standard', exact: true }).isDisabled(), 'Standard is disabled without built-in suppression');
  await plain.getByText('Unavailable in this browser. Strong still works, using its filter alone.', { exact: true }).waitFor();
  assert(await plain.getByRole('radio', { name: 'Strong', exact: true }).isEnabled(), 'Strong remains selectable without built-in suppression');
  await plain.getByRole('radio', { name: 'Strong', exact: true }).click();
  await plain.getByRole('button', { name: 'Done', exact: false }).click();
  await plain.getByRole('button', { name: 'Turn microphone on', exact: true }).click();
  await plain.getByRole('button', { name: 'Turn microphone off', exact: true }).waitFor();
  await plain.getByRole('button', { name: 'Microphone settings', exact: true }).click();
  await plain.getByRole('status').filter({ hasText: 'Strong noise filtering is active. This browser has no built-in suppression' }).waitFor();
  await plain.getByRole('button', { name: 'Done', exact: false }).click();
  await plain.getByRole('button', { name: 'Leave office', exact: true }).click();
  await plain.close();

  // Without AudioWorklet or WebAssembly, Strong is unavailable, even when Strong was the remembered choice.
  assert.equal(await page.evaluate(() => localStorage.getItem('bespingle_noise_level')), 'strong');
  for (const missing of ['AudioWorkletNode', 'WebAssembly']) {
    const lacking = await enter(`No ${missing}`, (missing) => { delete window[missing]; }, missing);
    assert(await lacking.getByRole('radio', { name: 'Strong', exact: true }).isDisabled(), `Strong is disabled with no ${missing}`);
    await lacking.locator('#noise-strong-note').filter({ hasText: 'Unavailable in this browser.' }).waitFor();
    assert(await lacking.getByRole('radio', { name: 'Standard', exact: true }).isChecked(), `Standard is the default with no ${missing}`);
    await lacking.getByRole('button', { name: 'Done', exact: false }).click();
    await turnOn(lacking);
    assert.equal(await lacking.getByRole('alert').count(), 0, `Turning the mic on with no ${missing} raises no alert`);
    assert.equal(await lacking.evaluate(() => window.__captures[0].constraints.audio.noiseSuppression), true, `Standard captures with built-in suppression with no ${missing}`);
    await lacking.close();
  }
  // The level is remembered across a reload, and a newly enabled microphone uses it.
  const remembered = await enter('Remembered level');
  await remembered.getByRole('radio', { name: 'Off', exact: true }).click();
  assert(await remembered.getByRole('radio', { name: 'Off', exact: true }).isChecked());
  assert.equal(await remembered.getByText('until you reload', { exact: false }).count(), 0, 'The dialog no longer says the choice lasts until reload');
  await remembered.getByText('Your noise choice is remembered in this browser.', { exact: false }).waitFor();
  await remembered.getByRole('button', { name: 'Done', exact: false }).click();
  await remembered.reload();
  await remembered.getByLabel('Your display name').fill('Remembered level');
  await remembered.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await remembered.getByRole('button', { name: 'Microphone settings', exact: true }).click();
  assert(await remembered.getByRole('radio', { name: 'Off', exact: true }).isChecked(), 'The noise level survives a reload');
  await remembered.getByRole('button', { name: 'Done', exact: false }).click();
  await turnOn(remembered);
  assert.equal(await remembered.evaluate(() => window.__captures[0].constraints.audio.noiseSuppression), false, 'The remembered Off captures without built-in suppression');
  assert.equal(await remembered.evaluate(() => window.__filterContexts.length), 0, 'The remembered Off starts no filter');
  await remembered.getByRole('button', { name: 'Leave office', exact: true }).click();
  await remembered.close();

  assert.deepEqual(errors, []);
  console.log('PASS: real browser noise levels: Strong default reached on the first mic-on, ⋯ settings opener by click and keyboard, choices with the mic off, capture constraints per level, Strong publishes the filter output, live switching without recapture, speaking on Strong, mid-call and startup filter failure fall back to Standard, failure recovery, mute/re-enable, cleanup, unsupported browsers defaulting to Standard without an alert, and the level remembered across a reload');
} finally {
  await browser.close();
}

// The RNNoise filter behind the Strong noise level.
await import('./noise-filter-smoke.mjs');
