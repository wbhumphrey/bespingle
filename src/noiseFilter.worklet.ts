// Runs RNNoise on the audio rendering thread. The page fetches the WebAssembly
// binary and passes its bytes in, because worklet scopes may lack fetch.
declare const sampleRate: number;
type Options = { processorOptions: { wasm: ArrayBuffer; bypassed?: boolean } };
declare function registerProcessor(name: string, processor: new (options: Options) => AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type Rnnoise = {
  memory: WebAssembly.Memory;
  emscripten_stack_init: () => void;
  __wasm_call_ctors: () => void;
  rnnoise_get_frame_size: () => number;
  rnnoise_create: (model: number) => number;
  rnnoise_destroy: (state: number) => void;
  rnnoise_process_frame: (state: number, output: number, input: number) => number;
  malloc: (size: number) => number;
  free: (pointer: number) => void;
};

const FRAME = 480; // 10 ms at 48 kHz
const QUANTUM = 128;
const SCALE = 32768; // RNNoise expects 16-bit sample values, not ±1 floats.
// After a bypass, a fresh RNNoise state hears this many frames before its output is used.
const WARMUP = 10;

// The Emscripten build needs only these three imports; its own JS glue is not used.
async function load(bytes: ArrayBuffer): Promise<Rnnoise> {
  let memory: WebAssembly.Memory | undefined;
  const { instance } = await WebAssembly.instantiate(bytes, { env: {
    emscripten_memcpy_big: (dest: number, src: number, num: number) => { new Uint8Array(memory!.buffer).copyWithin(dest, src, src + num); },
    emscripten_resize_heap: (requested: number) => {
      try { memory!.grow(Math.ceil(((requested >>> 0) - memory!.buffer.byteLength) / 65536)); return 1; } catch { return 0; }
    },
    __assert_fail: () => { throw new Error('RNNoise assertion failed.'); },
  } });
  const rnnoise = instance.exports as unknown as Rnnoise;
  memory = rnnoise.memory;
  rnnoise.emscripten_stack_init();
  rnnoise.__wasm_call_ctors();
  if (rnnoise.rnnoise_get_frame_size() !== FRAME) throw new Error('Unexpected RNNoise frame size.');
  return rnnoise;
}

class NoiseFilterProcessor extends AudioWorkletProcessor {
  private rnnoise?: Rnnoise;
  private state = 0;
  private input = 0;
  private output = 0;
  private pending = new Float32Array(FRAME);
  private pendingLength = 0;
  // Output lags input by one frame so every render quantum can be filled.
  private queue = new Float32Array(FRAME * 2 + QUANTUM);
  private queueLength = FRAME;
  private flowing = false;
  private stopped = false;
  // Bypassed audio is delayed by the frame RNNoise itself holds back, so both paths line up.
  private previous = new Float32Array(FRAME);
  private bypassed: boolean;
  // Share of the output taken from RNNoise; it ramps over one frame whenever the path changes.
  private mix: number;
  private stale: boolean; // RNNoise missed audio while bypassed and must start afresh.
  private warmup = 0;
  private denoised = 0;

  constructor({ processorOptions }: Options) {
    super();
    this.bypassed = processorOptions.bypassed === true;
    this.mix = this.bypassed ? 0 : 1;
    this.stale = this.bypassed;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop') this.release();
      else if (data?.type === 'bypass') this.bypassed = data.bypassed === true;
      else if (data?.type === 'stats') this.port.postMessage({ type: 'stats', bypassed: this.bypassed, denoised: this.denoised });
    };
    if (sampleRate !== 48000) { this.fail(`RNNoise needs 48 kHz audio, not ${sampleRate} Hz.`); return; }
    load(processorOptions.wasm).then((rnnoise) => {
      if (this.stopped) return;
      this.rnnoise = rnnoise;
      this.state = rnnoise.rnnoise_create(0);
      this.input = rnnoise.malloc(FRAME * 4);
      this.output = rnnoise.malloc(FRAME * 4);
      if (!this.state || !this.input || !this.output) throw new Error('Could not allocate RNNoise state.');
    }).catch((error) => this.fail(error instanceof Error ? error.message : 'Could not load RNNoise.'));
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    if (this.stopped) return false;
    if (!this.state) return true; // Still loading; the page waits for 'flowing'.
    try {
      const samples = inputs[0]?.[0];
      const out = outputs[0][0];
      for (let i = 0; i < QUANTUM; i++) {
        this.pending[this.pendingLength++] = samples ? samples[i] * SCALE : 0;
        if (this.pendingLength === FRAME) this.frame();
      }
      out.set(this.queue.subarray(0, QUANTUM));
      this.queue.copyWithin(0, QUANTUM, this.queueLength);
      this.queueLength -= QUANTUM;
      if (!this.flowing) { this.flowing = true; this.port.postMessage({ type: 'flowing' }); }
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'RNNoise processing failed.');
      return false;
    }
  }

  private frame() {
    const raw = this.previous;
    const at = this.queueLength;
    if (!this.bypassed && this.stale) {
      this.reset();
      this.stale = false; this.warmup = WARMUP;
    }
    if (this.bypassed && this.mix === 0) {
      this.stale = true;
      for (let i = 0; i < FRAME; i++) this.queue[at + i] = raw[i] / SCALE;
    } else {
      const denoised = this.denoise();
      if (this.warmup > 0) {
        this.warmup--;
        for (let i = 0; i < FRAME; i++) this.queue[at + i] = raw[i] / SCALE;
      } else if (!this.bypassed && this.mix === 1) {
        for (let i = 0; i < FRAME; i++) this.queue[at + i] = denoised[i] / SCALE;
      } else {
        // A one-frame crossfade, so changing path never steps the waveform.
        const from = this.mix; const to = this.bypassed ? 0 : 1;
        for (let i = 0; i < FRAME; i++) {
          const mix = from + (to - from) * (i + 1) / FRAME;
          this.queue[at + i] = (raw[i] * (1 - mix) + denoised[i] * mix) / SCALE;
        }
        this.mix = to;
      }
    }
    this.queueLength += FRAME;
    this.previous = this.pending; this.pending = raw;
    this.pendingLength = 0;
  }

  private denoise() {
    const rnnoise = this.rnnoise;
    if (!rnnoise) throw new Error('RNNoise stopped unexpectedly.');
    new Float32Array(rnnoise.memory.buffer, this.input, FRAME).set(this.pending);
    rnnoise.rnnoise_process_frame(this.state, this.output, this.input);
    this.denoised++;
    return new Float32Array(rnnoise.memory.buffer, this.output, FRAME);
  }

  // A state that missed audio would replay its old overlap and gains into the new audio.
  private reset() {
    const rnnoise = this.rnnoise;
    if (!rnnoise) throw new Error('RNNoise stopped unexpectedly.');
    rnnoise.rnnoise_destroy(this.state);
    this.state = rnnoise.rnnoise_create(0);
    if (!this.state) throw new Error('Could not allocate RNNoise state.');
  }

  private fail(message: string) {
    if (this.stopped) return;
    this.release();
    this.port.postMessage({ type: 'error', message });
  }

  private release() {
    if (this.stopped) return;
    this.stopped = true;
    const rnnoise = this.rnnoise;
    if (rnnoise) {
      if (this.state) rnnoise.rnnoise_destroy(this.state);
      if (this.input) rnnoise.free(this.input);
      if (this.output) rnnoise.free(this.output);
    }
    this.rnnoise = undefined; this.state = 0;
  }
}

registerProcessor('rnnoise', NoiseFilterProcessor);
