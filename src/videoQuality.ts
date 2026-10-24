import { CAMERA_RUNGS } from './cameraBackground';

export type VideoQuality = 'auto' | 'high' | 'low' | 'audio';
export const videoQualities: { id: VideoQuality; label: string; detail: string }[] = [
  { id: 'auto', label: 'Auto', detail: 'Lowers your video as the conversation grows' },
  { id: 'high', label: 'High', detail: 'Always send full quality' },
  { id: 'low', label: 'Low', detail: 'Always send reduced quality' },
  { id: 'audio', label: 'Audio only', detail: 'Others see your avatar instead of your camera' },
];

// Upper bounds for one outgoing video. They become sender encoding parameters,
// which never renegotiate the connection.
export type VideoCap = { width: number; height: number; frameRate: number; maxBitrate: number };
// `active: false` stops sending. A missing cap sends the track as captured.
export type SenderTarget = { active: boolean; cap?: VideoCap };
// `background` is the lightest camera background rung allowed, 0 being full
// quality. `noise` is the highest noise level allowed. Both are ceilings over
// the person's own choices, which they never rewrite.
export type QualityTarget = { camera: SenderTarget; screen: SenderTarget; background: number; noise: 'strong' | 'standard' };
// Which sections of the ladder can change anything right now. A section that
// cannot is left out, so no load step is spent on it either way.
export type LadderSections = {
  sharing: boolean;
  // A background is chosen and the camera is on.
  background: boolean;
  // Strong is chosen and its filter is running.
  noise: boolean;
};
export type QualityInput = LadderSections & {
  // Everyone on your carpet, including you. Every client sees the same count.
  participants: number;
  quality: VideoQuality;
  // How many rungs further down the ladder to go than the count alone sets.
  loadSteps: number;
};
export type LadderInput = Omit<QualityInput, 'loadSteps'>;

// One ordered ladder, highest quality first. Stepping down walks the camera
// rungs, then the background filter rungs, then screen-share rungs. New rungs
// are inserted in their section without reordering the others.
export type Rung = { kind: 'camera'; cap: VideoCap } | { kind: 'background'; rung: number } | { kind: 'noise' } | { kind: 'screen'; cap: VideoCap };
export const ladder: Rung[] = [
  { kind: 'camera', cap: { width: 1280, height: 720, frameRate: 30, maxBitrate: 2_500_000 } },
  { kind: 'camera', cap: { width: 960, height: 540, frameRate: 24, maxBitrate: 1_200_000 } },
  { kind: 'camera', cap: { width: 640, height: 360, frameRate: 15, maxBitrate: 500_000 } },
  // The camera background's lighter rungs, then Strong noise filtering down to
  // Standard. Both run in place, and noise filtering never goes below Standard.
  ...CAMERA_RUNGS.slice(1).map((_, index) => ({ kind: 'background', rung: index + 1 }) as const),
  { kind: 'noise' },
  // Screen share is the last resort. Shared text stays legible longest by
  // giving up frame rate before resolution.
  { kind: 'screen', cap: { width: 1920, height: 1080, frameRate: 8, maxBitrate: 1_500_000 } },
  { kind: 'screen', cap: { width: 1280, height: 720, frameRate: 5, maxBitrate: 800_000 } },
];

const cameraRungs = ladder.flatMap((rung, index) => rung.kind === 'camera' ? [index] : []);
const lowestCamera = cameraRungs[cameraRungs.length - 1];

function countRung(participants: number) {
  return participants >= 6 ? cameraRungs[2] : participants >= 4 ? cameraRungs[1] : cameraRungs[0];
}

// The ladder without the sections that would change nothing: screen-share
// rungs while not sharing, background rungs with no background running, and
// the noise rung unless Strong is running. Camera rungs always come first, so
// the count's starting point is the same in every shape.
function usableLadder({ sharing, background, noise }: LadderSections) {
  return ladder.filter((rung) => rung.kind === 'camera' || (rung.kind === 'screen' ? sharing : rung.kind === 'background' ? background : noise));
}

// How many load steps can still change something below the starting point, so
// recovery from load never waits on rungs that changed nothing.
export function loadHeadroom(input: LadderInput) {
  if (input.quality !== 'auto') return 0;
  return Math.max(0, usableLadder(input).length - 1 - countRung(input.participants));
}

// Load steps count rungs of the usable ladder, so when a section joins or
// leaves it, the same count would mean other rungs. This gives the count that
// keeps every section as it was: a section that leaves takes its own steps
// with it, and one that joins below a section already stepped down joins at
// its lowest rung, otherwise at full quality. Turning a filter on or off, or
// starting to share, never moves another section.
export function carrySteps(steps: number, from: LadderInput, to: LadderInput) {
  if (to.quality !== 'auto') return steps;
  const start = countRung(to.participants);
  const before = usableLadder(from);
  const after = usableLadder(to);
  const taken = new Map<Rung['kind'], number>();
  for (const rung of before.slice(start + 1, Math.min(before.length - 1, start + Math.max(0, Math.floor(steps))) + 1)) {
    taken.set(rung.kind, (taken.get(rung.kind) ?? 0) + 1);
  }
  const kinds = [...new Set(after.map((rung) => rung.kind))];
  return kinds.reduce((total, kind, index) => {
    if (before.some((rung) => rung.kind === kind)) return total + (taken.get(kind) ?? 0);
    const below = kinds.slice(index + 1).some((later) => (taken.get(later) ?? 0) > 0);
    return total + (below ? after.filter((rung) => rung.kind === kind).length : 0);
  }, 0);
}

export function qualityTarget(input: QualityInput): QualityTarget {
  const { participants, quality, loadSteps } = input;
  // Manual choices fix quality: they ignore count and load entirely.
  if (quality === 'audio') return { camera: { active: false }, screen: { active: true }, background: 0, noise: 'strong' };
  const usable = usableLadder(input);
  const start = quality === 'high' ? cameraRungs[0] : quality === 'low' ? lowestCamera : countRung(participants);
  const position = quality === 'auto' ? Math.min(usable.length - 1, start + Math.max(0, Math.floor(loadSteps))) : start;
  // Past a section, that section stays at its lowest rung; before it, at full quality.
  const reached = usable.slice(0, position + 1).reverse();
  const camera = reached.find((rung) => rung.kind === 'camera');
  const screen = reached.find((rung) => rung.kind === 'screen');
  const background = reached.find((rung) => rung.kind === 'background');
  return {
    camera: { active: true, cap: camera?.cap }, screen: { active: true, cap: screen?.cap },
    background: background?.rung ?? 0, noise: reached.some((rung) => rung.kind === 'noise') ? 'standard' : 'strong',
  };
}

// Turns a cap into encoding parameters for a track of the given size. The
// camera may not be 1280×720, and background processing produces its own track.
export function encodingFor(target: SenderTarget, size: { width?: number; height?: number } | undefined): Partial<RTCRtpEncodingParameters> {
  if (!target.cap) return { active: target.active, scaleResolutionDownBy: 1, maxFramerate: undefined, maxBitrate: undefined };
  const { width, height, frameRate, maxBitrate } = target.cap;
  // Without a known size assume the requested 720p capture.
  const scale = Math.max(1, (size?.width || 1280) / width, (size?.height || 720) / height);
  return { active: target.active, scaleResolutionDownBy: scale, maxFramerate: frameRate, maxBitrate };
}

const storageKey = 'bespingle_video_quality';
export function readVideoQuality(): VideoQuality {
  try {
    const value = localStorage.getItem(storageKey);
    return videoQualities.some((item) => item.id === value) ? value as VideoQuality : 'auto';
  } catch { return 'auto'; }
}
export function saveVideoQuality(quality: VideoQuality) {
  try { localStorage.setItem(storageKey, quality); } catch { /* Private modes may refuse storage. */ }
}
