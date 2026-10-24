import workletUrl from './noiseFilter.worklet.ts?worker&url';
import plainBinary from '../node_modules/@shiguredo/rnnoise-wasm/dist/rnnoise.wasm?url';
import simdBinary from '../node_modules/@shiguredo/rnnoise-wasm/dist/rnnoise_simd.wasm?url';

// While bypassed the filter stops running RNNoise and its track carries the microphone as it is.
export type NoiseFilter = { track: MediaStreamTrack; stop: () => void; setBypassed: (bypassed: boolean) => void };

// The smallest module using a SIMD instruction, as wasm-feature-detect checks it.
const simd = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export function noiseFilterSupported() {
  return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function'
    && typeof AudioContext === 'function' && typeof AudioWorkletNode === 'function' && 'audioWorklet' in AudioContext.prototype;
}

// Resolves once filtered audio is flowing. After that, failures are reported through
// onFailure exactly once. The source track belongs to the caller and is never stopped.
export async function createNoiseFilter(source: MediaStreamTrack, onFailure: (message: string) => void, signal?: AbortSignal, { bypassed = false }: { bypassed?: boolean } = {}): Promise<NoiseFilter> {
  if (!noiseFilterSupported()) throw new Error('The noise filter is not supported in this browser.');
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let input: MediaStreamAudioSourceNode | undefined;
  let output: MediaStreamAudioDestinationNode | undefined;
  let stopped = false;
  let started = false;
  let failure: Error | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveFlowing = () => {};
  let rejectStartup = (_error: Error) => {};
  const flowing = new Promise<void>((resolve, reject) => { resolveFlowing = resolve; rejectStartup = reject; });
  flowing.catch(() => {}); // Startup may fail before anything awaits this.
  const halt = (error: Error) => { failure ??= error; rejectStartup(error); };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    halt(new Error('Noise filter stopped.'));
    clearTimeout(timeout); clearTimeout(resumeTimer);
    source.removeEventListener('ended', ended);
    signal?.removeEventListener('abort', abort);
    if (node) { node.port.onmessage = null; node.removeEventListener('processorerror', broken); node.port.postMessage('stop'); node.disconnect(); }
    input?.disconnect();
    output?.stream.getTracks().forEach((track) => track.stop());
    if (context) { context.onstatechange = null; if (context.state !== 'closed') context.close().catch(() => {}); }
  };
  const fail = (message: string) => {
    if (stopped) return;
    halt(new Error(message)); stop();
    if (started) onFailure(message);
  };
  const abort = () => { halt(new Error('Noise filter startup cancelled.')); stop(); };
  const ended = () => fail('The microphone stopped, so the noise filter stopped.');
  const broken = () => fail('The noise filter stopped working.');
  const timeout = setTimeout(() => fail('The noise filter took too long to start.'), 10000);
  const check = () => { if (stopped) throw failure; };
  try {
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    check();
    if (source.readyState !== 'live') throw new Error('The microphone is not live.');
    const response = await fetch(WebAssembly.validate(simd) ? simdBinary : plainBinary, { signal });
    if (!response.ok) throw new Error('Could not load the noise filter.');
    const wasm = await response.arrayBuffer();
    check();
    // RNNoise is built for 48 kHz. Browsers that will not run a context at that rate
    // report the filter as unavailable rather than resampling.
    context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    if (context.sampleRate !== 48000) throw new Error('The noise filter needs 48 kHz audio.');
    context.onstatechange = () => {
      if (!context || stopped) return;
      if (context.state === 'closed') { fail('The noise filter stopped working.'); return; }
      if (context.state === 'running' || !started) return;
      // A context interrupted mid-call would otherwise send silence in place of the voice.
      context.resume().catch(() => {});
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => { if (context?.state !== 'running') fail('The noise filter stopped working.'); }, 3000);
    };
    await context.audioWorklet.addModule(workletUrl);
    check();
    node = new AudioWorkletNode(context, 'rnnoise', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { wasm, bypassed },
    });
    node.port.onmessage = ({ data }) => {
      if (data.type === 'flowing') resolveFlowing();
      if (data.type === 'error') fail(`The noise filter stopped working: ${data.message}`);
    };
    node.addEventListener('processorerror', broken);
    input = context.createMediaStreamSource(new MediaStream([source]));
    output = context.createMediaStreamDestination();
    output.channelCount = 1;
    input.connect(node).connect(output);
    source.addEventListener('ended', ended);
    // Resuming outside a user gesture can stay pending; the startup timeout covers a context that never runs.
    context.resume().catch(() => fail('The noise filter could not start audio processing.'));
    await flowing;
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    started = true;
    const setBypassed = (bypass: boolean) => {
      if (stopped || bypass === bypassed) return;
      bypassed = bypass; node!.port.postMessage({ type: 'bypass', bypassed });
    };
    return { track: output.stream.getAudioTracks()[0], stop, setBypassed };
  } catch (error) {
    const reason = failure ?? new Error(error instanceof Error ? error.message : 'Could not start the noise filter.');
    stop();
    throw reason;
  }
}
