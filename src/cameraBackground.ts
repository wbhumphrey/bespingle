export type CameraBackground = 'none' | 'blur' | 'sky' | 'forest' | 'custom';
// A rung can be changed at any time; the track keeps its object, its dimensions and its background.
export type CameraProcessor = { track: MediaStreamTrack; stop: () => void; setRung: (rung: number) => void };

// Lighter ways to run the same effect, from today's full cost down. Each waits longer after a
// result before sending the next frame and segments a smaller frame, which the page scales back
// up, so the output track never changes size.
export const CAMERA_RUNGS: readonly { readonly delay: number; readonly width: number }[] = [
  { delay: 50, width: 960 }, // About 20 segmentations a second.
  { delay: 100, width: 640 }, // About 10.
  { delay: 160, width: 480 }, // About 6.
];

const rungIndex = (rung: number) => Math.max(0, Math.min(CAMERA_RUNGS.length - 1, Math.round(rung) || 0));

// One in-flight frame bounds memory and lets slower devices reduce frame rate.
export async function createCameraBackground(source: MediaStreamTrack, background: CameraBackground, onFailure: (message: string) => void, image?: File, signal?: AbortSignal, { rung = 0 }: { rung?: number } = {}): Promise<CameraProcessor> {
  if (!window.Worker || !window.OffscreenCanvas || !HTMLCanvasElement.prototype.captureStream) {
    throw new Error('Camera backgrounds are not supported in this browser.');
  }
  const worker = new Worker(new URL('./cameraBackground.worker.ts', import.meta.url));
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true;
  video.srcObject = new MediaStream([source]);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  let output: MediaStream | undefined;
  let current = CAMERA_RUNGS[rungIndex(rung)];
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStartup: (error: Error) => void = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer); clearTimeout(timeout);
    worker.terminate(); video.pause(); video.srcObject = null;
    output?.getTracks().forEach((track) => track.stop());
    source.removeEventListener('ended', stop);
    signal?.removeEventListener('abort', stop);
    rejectStartup(new Error('Camera processing stopped.'));
  };
  const timeout = setTimeout(() => fail('Camera background initialization timed out.'), 30000);
  const fail = (message: string) => {
    if (stopped) return;
    rejectStartup(new Error(message)); stop(); onFailure(message);
  };
  worker.onerror = () => fail('Could not load camera background processing.');
  const next = async () => {
    if (stopped) return;
    try {
      const scale = Math.min(1, current.width / video.videoWidth);
      const frame = await createImageBitmap(video, { resizeWidth: Math.round(video.videoWidth * scale), resizeHeight: Math.round(video.videoHeight * scale) });
      if (stopped) { frame.close(); return; }
      worker.postMessage({ type: 'frame', frame, timestamp: performance.now(), background }, [frame]);
    } catch (error) { fail(error instanceof Error ? error.message : 'Camera frame failed.'); }
  };
  try {
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) throw new Error('Camera processing cancelled.');
    await video.play();
    let backgroundImage = image ? await createImageBitmap(image) : undefined;
    if (backgroundImage) {
      const scale = Math.min(1, 1920 / Math.max(backgroundImage.width, backgroundImage.height));
      if (scale < 1) {
        const resized = await createImageBitmap(backgroundImage, { resizeWidth: Math.max(1, Math.round(backgroundImage.width * scale)), resizeHeight: Math.max(1, Math.round(backgroundImage.height * scale)), resizeQuality: 'high' });
        backgroundImage.close(); backgroundImage = resized;
      }
    }
    if (stopped) { backgroundImage?.close(); throw new Error('Camera processing cancelled.'); }
    const scale = Math.min(1, 960 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    const ready = new Promise<void>((resolve, reject) => {
      rejectStartup = reject;
      worker.onmessage = ({ data }) => {
        if (data.type === 'error') { fail(data.message); return; }
        if (data.type === 'ready') { void next(); return; }
        if (data.type === 'frame') {
          // A lower rung's smaller frame is drawn back at the output size.
          context.drawImage(data.frame, 0, 0, canvas.width, canvas.height); data.frame.close();
          clearTimeout(timeout); resolve();
          timer = setTimeout(() => { void next(); }, current.delay);
        }
      };
      worker.postMessage({ type: 'init', image: backgroundImage, origin: location.origin, model: new URL(`${import.meta.env.BASE_URL}models/selfie_segmenter_landscape.tflite`, location.href).href }, backgroundImage ? [backgroundImage] : []);
    });
    await ready; // Never publish an unprocessed frame during model loading.
    output = canvas.captureStream(20);
    const track = output.getVideoTracks()[0];
    track.contentHint = 'motion';
    signal?.removeEventListener('abort', stop);
    source.addEventListener('ended', stop);
    return { track, stop, setRung: (rung) => { current = CAMERA_RUNGS[rungIndex(rung)]; } };
  } catch (error) { stop(); throw error; }
}
