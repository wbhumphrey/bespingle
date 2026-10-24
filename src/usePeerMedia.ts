import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { Player } from './world';
import type { Send, Signal } from './protocol';
import { createCameraBackground } from './cameraBackground';
import type { CameraBackground, CameraProcessor } from './cameraBackground';
import { carrySteps, encodingFor, loadHeadroom, qualityTarget, readVideoQuality, saveVideoQuality } from './videoQuality';
import { currentLoad, subscribeLoad, watchEncoders } from './deviceLoad';
import { LoadStepper } from './loadSteps';
import type { LadderInput, LadderSections, QualityTarget, SenderTarget, VideoQuality } from './videoQuality';
import { createNoiseFilter, noiseFilterSupported } from './noiseFilter';
import type { NoiseFilter } from './noiseFilter';
import { readBackground, readBackgroundImage, readNoiseLevel, saveBackground, saveBackgroundImage, saveNoiseLevel } from './mediaChoices';
import { pageDevices, recordDevices } from './session';

// Off sends the microphone untouched, Standard uses the browser's built-in noise
// suppression, and Strong adds the RNNoise filter on top of it.
export type NoiseLevel = 'off' | 'standard' | 'strong';
type ActiveFilter = NoiseFilter & { source: MediaStreamTrack };

// A track with no built-in suppression to switch, such as one not from a device, rejects the constraint outright.
const canSuppress = (track: MediaStreamTrack) => !track.getCapabilities || !!track.getCapabilities().noiseSuppression?.includes(true);

type PeerStatus = 'connecting' | 'connected' | 'disconnected' | 'failed';
export type RemoteMedia = { stream: MediaStream; screenStream: MediaStream; status: PeerStatus };
type Peer = {
  id: string;
  sessionId: string;
  pc: RTCPeerConnection;
  stream: MediaStream;
  screenStream: MediaStream;
  candidates: RTCIceCandidateInit[];
  queue: Promise<void>;
};

// Caps the sender in place. Encoding parameters never renegotiate, and they
// survive replaceTrack, but a scale factor depends on the track's size.
async function capSender(sender: RTCRtpSender, target: SenderTarget) {
  const parameters = sender.getParameters();
  // The answerer's senders have no encodings until its answer is applied.
  if (!parameters.encodings?.length) return;
  const settings = sender.track?.getSettings();
  const encoding = encodingFor(target, settings);
  parameters.encodings = parameters.encodings.map((item) => {
    const next = { ...item, ...encoding };
    for (const key of ['maxFramerate', 'maxBitrate'] as const) if (next[key] === undefined) delete next[key];
    return next;
  });
  await sender.setParameters(parameters);
}

const sameLadder = (a: LadderInput, b: LadderInput) => (Object.keys(a) as (keyof LadderInput)[]).every((key) => a[key] === b[key]);

// Where the Permissions API cannot answer, the permission counts as not granted.
async function permitted(name: 'camera' | 'microphone') {
  try { return (await navigator.permissions.query({ name: name as PermissionName })).state === 'granted'; } catch { return false; }
}

function leftOffNote(mic: boolean, camera: boolean) {
  if (mic && camera) return 'Your microphone and camera were left off because the browser needs your permission to use them. Turn them on to allow them.';
  return `Your ${mic ? 'microphone' : 'camera'} was left off because the browser needs your permission to use it. Turn it on to allow it.`;
}

// Discovery only. There are deliberately no TURN URLs or server media endpoints.
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
};

export function usePeerMedia(
  self: Player | undefined,
  players: Player[],
  send: Send,
  signalHandler: MutableRefObject<(signal: Signal) => void>,
  rejoined = false,
) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteMedia, setRemoteMedia] = useState<Record<string, RemoteMedia>>({});
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenBusy, setScreenBusy] = useState(false);
  const screen = useRef<MediaStream | null>(null);
  const screenRequest = useRef(0);
  const [error, setError] = useState('');
  const clearError = useCallback(() => setError(''), []);
  const [busy, setBusy] = useState(false);
  const [hasChosenDevices, setHasChosenDevices] = useState(false);
  const peers = useRef(new Map<string, Peer>());
  const local = useRef<MediaStream | null>(null);
  const capture = useRef<MediaStream | null>(null);
  const standardSupported = !!navigator.mediaDevices?.getSupportedConstraints().noiseSuppression;
  const strongSupported = noiseFilterSupported();
  // The remembered level, else Strong where the browser can run the filter. A remembered Strong
  // the browser cannot run starts at Standard, as the default does.
  const [noiseLevel, setNoiseLevel] = useState<NoiseLevel>(() => {
    const remembered = readNoiseLevel() ?? 'strong';
    return remembered === 'strong' && !strongSupported ? 'standard' : remembered;
  });
  const levelChoice = useRef<NoiseLevel>(noiseLevel);
  const levelRequest = useRef(0);
  const [levelBusy, setLevelBusy] = useState(false);
  const [noiseActive, setNoiseActive] = useState<boolean | undefined>(undefined);
  const [filtering, setFiltering] = useState(false);
  const filter = useRef<ActiveFilter | null>(null);
  const filterStarting = useRef<AbortController | null>(null);
  const processor = useRef<CameraProcessor | null>(null);
  const [background, setBackground] = useState<CameraBackground>(readBackground);
  const backgroundChoice = useRef<CameraBackground>(background);
  const backgroundImage = useRef<File | undefined>(undefined);
  // A remembered custom background needs its image read back from storage first. If it cannot
  // be, the background becomes Blur, so the person's surroundings stay hidden.
  const imageRestore = useRef<Promise<void> | null>(null);
  const restoreImage = useCallback(() => {
    imageRestore.current ??= backgroundChoice.current !== 'custom' ? Promise.resolve() : readBackgroundImage().then(
      (image) => { backgroundImage.current ??= image; },
      () => {
        if (backgroundChoice.current !== 'custom' || backgroundImage.current) return;
        backgroundChoice.current = 'blur'; setBackground('blur');
      });
    return imageRestore.current;
  }, []);
  useEffect(() => { void restoreImage(); }, [restoreImage]);
  const processing = useRef<AbortController | null>(null);
  const [quality, setQuality] = useState<VideoQuality>(readVideoQuality);
  const qualityChoice = useRef(quality);
  qualityChoice.current = quality;
  const [cameraOn, setCameraOn] = useState(false);
  const participants = self?.carpetId ? players.filter((player) => player.carpetId === self.carpetId).length : 1;
  // Bypassing Strong leaves only the built-in suppression, so the noise rung
  // counts only while that is known to be on. Without it, a bypass would send
  // the microphone unsuppressed, and noise filtering never steps down to Off.
  const ladder: LadderInput = { participants, quality, sharing: !!screenStream, background: background !== 'none' && cameraOn, noise: noiseLevel === 'strong' && filtering && standardSupported && noiseActive === true };
  // Further step-downs for device load, below what the count alone sets, and
  // the ladder they were counted on.
  const [load, setLoad] = useState<{ steps: number; ladder: LadderInput }>({ steps: 0, ladder });
  const headroom = loadHeadroom(ladder);
  const loadSteps = Math.min(carrySteps(load.steps, load.ladder, ladder), headroom);
  const ceiling = qualityTarget({ ...ladder, loadSteps });
  const policy = useRef({ load, ladder });
  policy.current = { load, ladder };
  const target = useRef<QualityTarget>(ceiling);
  const context = useRef({ self, players });
  context.current = { self, players };
  const epoch = useRef(0);
  const request = useRef(0);
  const activeCarpet = self?.carpetId ?? '';
  const activeSelf = self?.id ?? '';
  const rejoin = useRef(rejoined);
  rejoin.current = rejoined;
  // Someone rejoining has already answered the device prompt if this session ever did.
  const answeredBefore = rejoined && !!activeSelf && pageDevices() !== null;

  const stopFilter = useCallback(() => {
    filterStarting.current?.abort(); filterStarting.current = null;
    filter.current?.stop(); filter.current = null;
  }, []);

  const stopCapture = useCallback(() => {
    processing.current?.abort(); processing.current = null;
    processor.current?.stop(); processor.current = null;
    stopFilter();
    capture.current?.getTracks().forEach((track) => track.stop()); capture.current = null;
    local.current?.getTracks().forEach((track) => track.stop());
    local.current = null;
    setLocalStream(null);
    setCameraOn(false);
    setNoiseActive(undefined);
    setFiltering(false);
  }, [stopFilter]);

  const removePeer = useCallback((id: string) => {
    const peer = peers.current.get(id);
    if (!peer) return;
    peers.current.delete(id);
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.onicecandidate = null;
    peer.pc.close();
    peer.screenStream.getTracks().forEach((track) => track.stop());
    peer.stream.getTracks().forEach((track) => track.stop());
    setRemoteMedia((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const reportFailure = useCallback((peer: Peer, failure: unknown) => {
    if (peers.current.get(peer.id) !== peer) return;
    console.warn('Direct peer connection:', failure);
    setRemoteMedia((current) => ({ ...current, [peer.id]: { stream: peer.stream, screenStream: peer.screenStream, status: 'failed' } }));
  }, []);

  const applyQuality = useCallback((peer: Peer) => {
    peer.queue = peer.queue.then(async () => {
      if (peers.current.get(peer.id) !== peer) return;
      const [, camera, screenSlot] = peer.pc.getTransceivers();
      try {
        if (camera) await capSender(camera.sender, target.current.camera);
        if (screenSlot) await capSender(screenSlot.sender, target.current.screen);
      } catch (failure) {
        // Quality is best effort and must never interrupt the call.
        if (peers.current.get(peer.id) === peer) console.warn('Video quality:', failure);
      }
    });
  }, []);

  const createPeer = useCallback((id: string, sessionId: string, offering = true): Peer => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const stream = new MediaStream();
    const screenStream = new MediaStream();
    const peer: Peer = { id, sessionId, pc, stream, screenStream, candidates: [], queue: Promise.resolve() };
    peers.current.set(id, peer);
    // The answerer must use the transceivers created by setRemoteDescription.
    // Precreating its own would leave the offered sections receive-only.
    if (offering) {
      // Stable slots: microphone, camera, screen. Reserving the screen slot
      // lets either participant start sharing without renegotiation or glare.
      for (const [index, kind] of (['audio', 'video', 'video'] as const).entries()) {
        const track = index === 2 ? screen.current?.getVideoTracks()[0] : local.current?.getTracks().find((item) => item.kind === kind);
        const transceiver = pc.addTransceiver(track ?? kind, { direction: 'sendrecv' });
        const source = index === 2 ? screen.current : local.current;
        if (source) transceiver.sender.setStreams(source);
      }
    }
    setRemoteMedia((current) => ({ ...current, [id]: { stream, screenStream, status: 'connecting' } }));
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || candidate.type === 'relay' || peers.current.get(id) !== peer) return;
      send({ type: 'signal', to: id, sessionId, candidate: candidate.toJSON() });
    };
    pc.ontrack = ({ track, transceiver }) => {
      if (peers.current.get(id) !== peer) return;
      const destination = pc.getTransceivers().indexOf(transceiver) === 2 ? screenStream : stream;
      if (!destination.getTracks().some((item) => item.id === track.id)) destination.addTrack(track);
      setRemoteMedia((current) => ({ ...current, [id]: { stream, screenStream, status: pc.connectionState === 'connected' ? 'connected' : 'connecting' } }));
    };
    pc.onconnectionstatechange = () => {
      if (peers.current.get(id) !== peer) return;
      const state = pc.connectionState;
      const status: PeerStatus = state === 'connected' ? 'connected' : state === 'failed' ? 'failed' : state === 'disconnected' || state === 'closed' ? 'disconnected' : 'connecting';
      setRemoteMedia((current) => ({ ...current, [id]: { stream, screenStream, status } }));
    };
    return peer;
  }, [send]);

  const receiveSignal = useCallback((signal: Signal) => {
    const { self: currentSelf, players: currentPlayers } = context.current;
    const from = signal.from;
    if (!currentSelf?.carpetId || !from || signal.to !== currentSelf.id) return;
    const remote = currentPlayers.find((player) => player.id === from);
    if (!remote || remote.carpetId !== currentSelf.carpetId) return;
    let peer = peers.current.get(from);
    if (signal.description?.type === 'offer') {
      // Exactly one caller per pair avoids simultaneous offers (glare).
      if (from >= currentSelf.id) return;
      if (peer && peer.sessionId !== signal.sessionId) {
        removePeer(from);
        peer = undefined;
      }
      peer ??= createPeer(from, signal.sessionId, false);
    }
    if (!peer || peer.sessionId !== signal.sessionId) return;
    const target = peer;
    target.queue = target.queue.then(async () => {
      if (peers.current.get(from) !== target) return;
      if (signal.description) {
        await target.pc.setRemoteDescription(signal.description);
        for (const candidate of target.candidates.splice(0)) await target.pc.addIceCandidate(candidate);
        if (signal.description.type === 'answer') applyQuality(target);
        if (signal.description.type === 'offer') {
          for (const [index, transceiver] of target.pc.getTransceivers().entries()) {
            transceiver.direction = 'sendrecv';
            const track = (index === 2 ? screen.current?.getVideoTracks()[0] : local.current?.getTracks().find((item) => item.kind === transceiver.receiver.track.kind)) ?? null;
            await transceiver.sender.replaceTrack(track);
            const source = index === 2 ? screen.current : local.current;
            if (source) transceiver.sender.setStreams(source);
          }
          const answer = await target.pc.createAnswer();
          await target.pc.setLocalDescription(answer);
          if (peers.current.get(from) === target) {
            send({ type: 'signal', to: from, sessionId: target.sessionId, description: target.pc.localDescription!.toJSON() });
          }
          applyQuality(target);
        }
      } else if (signal.candidate) {
        if (signal.candidate.candidate?.includes(' typ relay ')) return;
        if (target.pc.remoteDescription) await target.pc.addIceCandidate(signal.candidate);
        else target.candidates.push(signal.candidate);
      }
    }).catch((failure) => reportFailure(target, failure));
  }, [applyQuality, createPeer, removePeer, reportFailure, send]);

  useLayoutEffect(() => {
    signalHandler.current = receiveSignal;
    return () => { signalHandler.current = () => {}; };
  }, [receiveSignal, signalHandler]);

  // Capture belongs to the game session, not the current conversation carpet.
  useLayoutEffect(() => {
    epoch.current += 1;
    request.current += 1;
    levelRequest.current += 1;
    stopCapture();
    setLevelBusy(false);
    setHasChosenDevices(false);
    setError('');
    setBusy(false);
    return () => {
      epoch.current += 1;
      request.current += 1;
      levelRequest.current += 1;
      processing.current?.abort(); processing.current = null;
      processor.current?.stop(); processor.current = null;
      stopFilter();
      capture.current?.getTracks().forEach((track) => track.stop()); capture.current = null;
      local.current?.getTracks().forEach((track) => track.stop());
      local.current = null;
    };
  }, [activeSelf, stopCapture, stopFilter]);

  // Only peer connections belong to a carpet. No media is sent on the open floor.
  useLayoutEffect(() => {
    for (const id of peers.current.keys()) removePeer(id);
    setRemoteMedia({});
    return () => {
      for (const peer of peers.current.values()) {
        peer.pc.ontrack = null;
        peer.pc.onconnectionstatechange = null;
        peer.pc.onicecandidate = null;
        peer.pc.close();
        peer.screenStream.getTracks().forEach((track) => track.stop());
        peer.stream.getTracks().forEach((track) => track.stop());
      }
      peers.current.clear();
    };
  }, [activeCarpet, activeSelf, removePeer]);

  useEffect(() => {
    if (!self?.carpetId) return;
    const members = players.filter((player) => player.id !== self.id && player.carpetId === self.carpetId);
    for (const id of peers.current.keys()) {
      if (!members.some((member) => member.id === id)) removePeer(id);
    }
    for (const member of members) {
      if (self.id >= member.id || peers.current.has(member.id)) continue;
      const peer = createPeer(member.id, crypto.randomUUID());
      peer.queue = peer.queue.then(async () => {
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        if (peers.current.get(member.id) !== peer) return;
        send({ type: 'signal', to: member.id, sessionId: peer.sessionId, description: peer.pc.localDescription!.toJSON() });
      }).catch((failure) => reportFailure(peer, failure));
      applyQuality(peer);
    }
  }, [players, self, applyQuality, createPeer, removePeer, reportFailure, send]);

  // In Audio only the camera keeps capturing, so switching back is instant, but
  // peers are told it is off so their tile shows the avatar, not a dead frame.
  const publishStatus = useCallback(() => {
    const stream = local.current;
    const camera = stream?.getVideoTracks().some((track) => track.readyState === 'live') ?? false;
    setCameraOn(camera);
    send({ type: 'media',
      mic: stream?.getAudioTracks().some((track) => track.readyState === 'live') ?? false,
      screen: screen.current?.getVideoTracks().some((track) => track.readyState === 'live') ?? false,
      camera: camera && qualityChoice.current !== 'audio',
    });
  }, [send]);

  const publishCapture = useCallback((raw: MediaStream | null) => {
    capture.current = raw;
    const microphone = raw?.getAudioTracks().find((track) => track.readyState === 'live');
    // Built-in suppression is read from the capture track; the filter's output reports nothing.
    setNoiseActive(microphone?.getSettings().noiseSuppression);
    const filtered = filter.current && filter.current.source === microphone ? filter.current.track : null;
    setFiltering(!!filtered);
    const tracks = raw?.getTracks().map((track) => track.kind === 'video' && processor.current ? processor.current.track : track === microphone && filtered ? filtered : track) ?? [];
    const stream = tracks.length ? new MediaStream(tracks) : null;
    local.current = stream;
    setLocalStream(stream);
    publishStatus();
  }, [publishStatus]);

  const syncSenders = useCallback(async () => {
    const tracks = local.current?.getTracks() ?? [];
    await Promise.all([...peers.current.values()].flatMap((peer) => (
      peer.pc.getTransceivers().map(async (transceiver, index) => {
        const track = (index === 2 ? screen.current?.getVideoTracks().find((item) => item.readyState === 'live') : tracks.find((item) => item.kind === transceiver.receiver.track.kind && item.readyState === 'live')) ?? null;
        try {
          await transceiver.sender.replaceTrack(track);
        } catch (failure) {
          // A carpet change can close a peer while its sender is being updated.
          // Capture must remain enabled independently of any individual peer.
          reportFailure(peer, failure);
        }
      })
    )));
    // A replaced track may differ in size, which changes its scale factor.
    for (const peer of peers.current.values()) applyQuality(peer);
  }, [applyQuality, reportFailure]);

  // The device-load monitor is shared with the rest of the app. This lends it
  // the outgoing video senders and turns its level into load steps.
  useEffect(() => {
    const stepper = new LoadStepper();
    let counted = policy.current.ladder;
    const update = () => {
      const { ladder } = policy.current;
      stepper.steps = carrySteps(stepper.steps, counted, ladder);
      counted = ladder;
      const steps = stepper.update(currentLoad(), performance.now(), loadHeadroom(ladder));
      setLoad((current) => current.steps === steps && sameLadder(current.ladder, ladder) ? current : { steps, ladder });
    };
    const unsubscribe = subscribeLoad(update);
    const unwatch = watchEncoders(() => [...peers.current.values()].flatMap(({ pc }) => (
      pc.connectionState === 'connected' ? pc.getTransceivers().slice(1, 3).flatMap(({ sender }) => sender.track ? [sender] : []) : []
    )));
    // Holds elapse between level changes, so the stepper also runs on a clock.
    const timer = setInterval(update, 1000);
    return () => { clearInterval(timer); unwatch(); unsubscribe(); };
  }, []);

  // Every client sees the same count, so a carpet steps down together.
  const senderCaps = JSON.stringify([ceiling.camera, ceiling.screen]);
  useEffect(() => {
    if (senderCaps === JSON.stringify([target.current.camera, target.current.screen])) return;
    target.current = ceiling;
    for (const peer of peers.current.values()) applyQuality(peer);
  }, [senderCaps, applyQuality]);

  // The filters follow their ceilings in place. A new processor or filter is
  // published as a new local stream, so it is brought to the ceiling too.
  useEffect(() => {
    processor.current?.setRung(ceiling.background);
    filter.current?.setBypassed(ceiling.noise === 'standard');
  }, [ceiling.background, ceiling.noise, localStream]);

  // The ceiling a filter about to start would be held to, so it starts there.
  const ceilingWith = useCallback((sections: Partial<LadderSections>) => {
    const { load, ladder } = policy.current;
    const next = { ...ladder, ...sections };
    return qualityTarget({ ...next, loadSteps: Math.min(carrySteps(load.steps, load.ladder, next), loadHeadroom(next)) });
  }, []);

  const chooseQuality = useCallback((choice: VideoQuality) => {
    qualityChoice.current = choice;
    setQuality(choice);
    saveVideoQuality(choice);
    publishStatus();
  }, [publishStatus]);

  const strongStopped = useCallback((message: string) => (
    `Strong noise filtering stopped. ${message} ${standardSupported ? 'Your microphone is using Standard noise suppression.' : 'Your microphone is being sent without noise suppression.'}`
  ), [standardSupported]);

  // Starts Strong on a live microphone track. Unlike a failed camera effect, which stops the
  // camera, a failed filter republishes the raw track at Standard so the participant stays audible.
  const startFilter = useCallback(async (source: MediaStreamTrack): Promise<ActiveFilter> => {
    const controller = new AbortController(); filterStarting.current = controller;
    let active: ActiveFilter | null = null;
    try {
      // It starts at its ceiling, and as in the ladder the noise rung counts only where bypassing leaves built-in suppression on.
      const started = await createNoiseFilter(source, (message) => {
        if (!active || filter.current !== active) return;
        filter.current = null;
        publishCapture(capture.current);
        void syncSenders();
        // A microphone that ended took the filter with it; there is nothing to fall back to.
        if (source.readyState !== 'live') return;
        levelChoice.current = 'standard'; setNoiseLevel('standard');
        setError(strongStopped(message));
      }, controller.signal, { bypassed: ceilingWith({ noise: standardSupported && source.getSettings().noiseSuppression === true }).noise === 'standard' });
      active = { ...started, source };
      return active;
    } finally { if (filterStarting.current === controller) filterStarting.current = null; }
  }, [ceilingWith, publishCapture, standardSupported, strongStopped, syncSenders]);

  const [whiteboardActive, setWhiteboardActive] = useState(false);
  const whiteboardRef = useRef(false);

  const stopScreen = useCallback(() => {
    screenRequest.current += 1;
    screen.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    screen.current = null;
    setScreenStream(null);
    setScreenBusy(false);
    setWhiteboardActive(false);
    whiteboardRef.current = false;
    publishCapture(capture.current);
    void syncSenders();
  }, [publishCapture, syncSenders]);

  useLayoutEffect(() => {
    stopScreen();
    return () => {
      screenRequest.current += 1;
      screen.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
      screen.current = null;
    };
  }, [activeCarpet, activeSelf, stopScreen]);

  const startScreen = useCallback(async () => {
    const owner = context.current.self;
    if (!owner?.carpetId || screen.current) return;
    const requestId = ++screenRequest.current;
    const isCurrent = () => requestId === screenRequest.current && context.current.self?.id === owner.id && context.current.self?.carpetId === owner.carpetId;
    setScreenBusy(true);
    setError('');
    let acquired: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing requires a supported browser on localhost or HTTPS.');
      // Keep this call directly in the click handler's activation, before any await.
      acquired = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15, max: 30 } }, audio: false });
      if (!isCurrent()) { acquired.getTracks().forEach((track) => track.stop()); return; }
      const track = acquired.getVideoTracks()[0];
      if (!track || track.readyState !== 'live') throw new Error('No screen was selected.');
      track.contentHint = 'detail';
      track.onended = stopScreen;
      screen.current = acquired;
      setScreenStream(acquired);
      publishCapture(capture.current);
      await syncSenders();
    } catch (failure) {
      acquired?.getTracks().forEach((track) => track.stop());
      if (isCurrent() && !(failure instanceof DOMException && failure.name === 'NotAllowedError')) {
        setError(failure instanceof Error ? failure.message : 'Could not share your screen.');
      }
    } finally {
      if (isCurrent()) setScreenBusy(false);
    }
  }, [publishCapture, stopScreen, syncSenders]);

  const startWhiteboard = useCallback((stream: MediaStream) => {
    const owner = context.current.self;
    if (!owner?.carpetId) return;
    // Block if a real screen share is active, but allow replacing a previous whiteboard stream
    // (handles React StrictMode double-mount creating a second stream).
    if (screen.current && !whiteboardRef.current) return;
    if (screen.current) {
      // Replace previous whiteboard stream — detach onended so stopScreen isn't triggered.
      screen.current.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    }
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') return;
    track.contentHint = 'detail';
    track.onended = stopScreen;
    screen.current = stream;
    setScreenStream(stream);
    setWhiteboardActive(true);
    whiteboardRef.current = true;
    publishCapture(capture.current);
    void syncSenders();
  }, [publishCapture, stopScreen, syncSenders]);

  // The device buttons and the prompt record what they choose. A restore does not: it brings
  // back that choice, possibly only in part, and the choice stands for the next rejoin.
  const acquire = useCallback(async (mic: boolean, camera: boolean, record: boolean): Promise<boolean> => {
    const playerId = context.current.self?.id;
    if (!playerId) return false;
    const generation = epoch.current;
    const requestId = ++request.current;
    const isCurrent = () => generation === epoch.current && requestId === request.current && context.current.self?.id === playerId;
    setBusy(true);
    setError('');
    let acquired: MediaStream | null = null;
    try {
      // Reuse each enabled device's live track. Toggling the other device must
      // not reopen or interrupt it, and explicitly disabled tracks stop now.
      const retained = (capture.current?.getTracks() ?? []).filter((track) => {
        const wanted = track.kind === 'audio' ? mic : camera;
        if (!wanted) {
          if (track.kind === 'video') { processor.current?.stop(); processor.current = null; }
          // Stopped first, so the ending microphone is not reported as a filter failure.
          if (track.kind === 'audio') stopFilter();
          track.stop();
        }
        return wanted && track.readyState === 'live';
      });
      publishCapture(retained.length ? new MediaStream(retained) : null);
      await syncSenders();
      if (!isCurrent()) return false;

      const needMic = mic && !retained.some((track) => track.kind === 'audio');
      const needCamera = camera && !retained.some((track) => track.kind === 'video');
      if (needMic || needCamera) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera and microphone require localhost or HTTPS.');
        acquired = await navigator.mediaDevices.getUserMedia({
          audio: needMic ? { echoCancellation: true, noiseSuppression: levelChoice.current !== 'off', autoGainControl: true } : false,
          video: needCamera ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } : false,
        });
      }
      if (!isCurrent()) {
        acquired?.getTracks().forEach((track) => track.stop());
        return false;
      }

      const micTrack = acquired?.getAudioTracks()[0];
      if (micTrack && levelChoice.current === 'strong') {
        let next: ActiveFilter | null = null;
        try { next = await startFilter(micTrack); } catch (failure) {
          if (isCurrent()) {
            levelChoice.current = 'standard'; setNoiseLevel('standard');
            setError(strongStopped(failure instanceof Error ? failure.message : 'The noise filter could not start.'));
          }
        }
        if (!isCurrent()) { next?.stop(); acquired?.getTracks().forEach((track) => track.stop()); return false; }
        filter.current?.stop(); filter.current = next;
      }
      // The level may have changed while the microphone was opening; it is recorded, not applied, then.
      if (micTrack && filter.current?.source === micTrack && levelChoice.current !== 'strong') stopFilter();
      if (micTrack && standardSupported && canSuppress(micTrack) && micTrack.getConstraints().noiseSuppression !== (levelChoice.current !== 'off')) {
        await micTrack.applyConstraints({ ...micTrack.getConstraints(), noiseSuppression: levelChoice.current !== 'off' }).catch(() => {});
        if (!isCurrent()) { acquired?.getTracks().forEach((track) => track.stop()); return false; }
      }

      const cameraTrack = acquired?.getVideoTracks()[0];
      // A camera enabled before the remembered image is read back waits for it.
      if (cameraTrack && backgroundChoice.current === 'custom' && !backgroundImage.current) {
        await restoreImage();
        if (!isCurrent()) { acquired?.getTracks().forEach((track) => track.stop()); return false; }
      }
      if (cameraTrack && backgroundChoice.current !== 'none') {
        const controller = new AbortController(); processing.current = controller;
        const next = await createCameraBackground(cameraTrack, backgroundChoice.current, (message) => {
          if (!capture.current?.getVideoTracks().includes(cameraTrack)) return;
          setError(`Camera background stopped. ${message}`);
          cameraTrack.stop(); processor.current?.stop(); processor.current = null;
          publishCapture(new MediaStream((capture.current?.getAudioTracks() ?? [])));
          void syncSenders();
        }, backgroundChoice.current === 'custom' ? backgroundImage.current : undefined, controller.signal, { rung: ceilingWith({ background: true }).background });
        if (processing.current === controller) processing.current = null;
        if (!isCurrent()) { next.stop(); acquired?.getTracks().forEach((track) => track.stop()); return false; }
        processor.current = next;
      }
      const tracks = [...retained, ...(acquired?.getTracks() ?? [])].filter((track) => track.readyState === 'live');
      publishCapture(tracks.length ? new MediaStream(tracks) : null);
      await syncSenders();
      if (!isCurrent()) {
        // A later choice may have retained these same live tracks. Only release
        // newly acquired tracks which the current selection no longer owns.
        const currentTracks = capture.current?.getTracks() ?? [];
        acquired?.getTracks().forEach((track) => {
          if (!currentTracks.includes(track)) track.stop();
        });
        return false;
      }
      if (record) recordDevices({ mic, camera });
      setHasChosenDevices(true);
      return true;
    } catch (failure) {
      if (filter.current && acquired?.getTracks().includes(filter.current.source)) stopFilter();
      acquired?.getTracks().forEach((track) => track.stop());
      if (isCurrent()) {
        // Permission failure for a new device must not disable an existing one.
        const remaining = capture.current?.getTracks().filter((track) => track.readyState === 'live') ?? [];
        publishCapture(remaining.length ? new MediaStream(remaining) : null);
        await syncSenders();
        if (!isCurrent()) return false;
        const detail = failure instanceof Error ? failure.message : 'The device could not be opened.';
        setError(`Could not enable the requested devices. ${detail}`);
      }
      return false;
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, [ceilingWith, publishCapture, restoreImage, standardSupported, startFilter, stopFilter, strongStopped, syncSenders]);
  const chooseMedia = useCallback((mic: boolean, camera: boolean) => acquire(mic, camera, true), [acquire]);

  // After a rejoin's welcome, what was on comes back on, but only where the browser still
  // grants the permission, so it never raises a request the person did not make. A click
  // or leaving meanwhile supersedes it.
  useEffect(() => {
    const choice = rejoin.current && activeSelf ? pageDevices() : null;
    if (!choice?.mic && !choice?.camera) return;
    const generation = epoch.current;
    const requestId = request.current;
    const isCurrent = () => generation === epoch.current && requestId === request.current;
    let live = true;
    void (async () => {
      const [mic, camera] = await Promise.all([choice.mic && permitted('microphone'), choice.camera && permitted('camera')]);
      if (!live || !isCurrent()) return;
      if ((mic || camera) && !await acquire(mic, camera, false)) return;
      if (live && (choice.mic !== mic || choice.camera !== camera)) setError(leftOffNote(choice.mic && !mic, choice.camera && !camera));
    })();
    return () => { live = false; };
  }, [activeSelf, acquire]);

  // The one way to change the person's noise level, from the settings dialog. Device load never
  // comes through here: it holds Strong's filter bypassed in place, below a choice it leaves as is.
  // With the microphone off it only records the choice. With it on, built-in suppression is
  // toggled on the live capture track and each sender's track is replaced in place, so nothing
  // is recaptured or renegotiated. Resolves to the level in effect afterwards.
  // A level that is recorded or applied is remembered for later visits unless `remember` is false,
  // which a runtime change should pass. A Strong that falls back to Standard is remembered as Strong,
  // so a filter that failed once is tried again next visit.
  const chooseNoiseLevel = useCallback(async function choose(level: NoiseLevel, remember = true): Promise<NoiseLevel> {
    if (level === 'strong' && !strongSupported) return levelChoice.current;
    const generation = epoch.current;
    const requestId = ++levelRequest.current;
    const track = capture.current?.getAudioTracks().find((item) => item.readyState === 'live');
    if (!track) {
      // As the latest request, this also clears a busy state left by a change it overtook.
      levelChoice.current = level; setNoiseLevel(level); setLevelBusy(false);
      if (remember) saveNoiseLevel(level);
      return level;
    }
    filterStarting.current?.abort();
    const isLatest = () => generation === epoch.current && requestId === levelRequest.current;
    // A microphone turned off or reopened meanwhile makes this change stale too.
    const isCurrent = () => isLatest() && !!capture.current?.getAudioTracks().includes(track) && track.readyState === 'live';
    // A change overtaken only by the microphone still stands: it is recorded with the microphone
    // off, or applied to the microphone that replaced this one.
    const stale = () => isLatest() ? choose(level, remember) : levelChoice.current;
    setLevelBusy(true); setError('');
    let next: ActiveFilter | null = null;
    try {
      // Preserves echo cancellation and gain control on the same capture track.
      if (standardSupported && canSuppress(track)) await track.applyConstraints({ ...track.getConstraints(), noiseSuppression: level !== 'off' });
      if (!isCurrent()) return stale();
      const previous = filter.current;
      let stopped = '';
      if (level === 'strong' && previous?.source === track) next = previous;
      else if (level === 'strong') {
        try { next = await startFilter(track); } catch (failure) {
          stopped = failure instanceof Error ? failure.message : 'The noise filter could not start.';
        }
        if (!isCurrent()) { next?.stop(); return stale(); }
      }
      // The new track is ready before any sender changes, and the old filter stops only after.
      const effective: NoiseLevel = level === 'strong' && !next ? 'standard' : level;
      filter.current = next;
      levelChoice.current = effective; setNoiseLevel(effective);
      if (remember) saveNoiseLevel(level);
      publishCapture(capture.current);
      await syncSenders();
      if (previous !== next) previous?.stop();
      if (stopped && isCurrent()) setError(strongStopped(stopped));
      return effective;
    } catch (failure) {
      if (next && next !== filter.current) next.stop();
      if (!isCurrent()) return stale();
      setError(`Could not change noise suppression. ${failure instanceof Error ? failure.message : 'Please try again.'}`);
      return levelChoice.current;
    } finally { if (isLatest()) setLevelBusy(false); }
  }, [publishCapture, standardSupported, startFilter, strongStopped, strongSupported, syncSenders]);

  const chooseBackground = useCallback(async (choice: CameraBackground, image?: File) => {
    const generation = epoch.current;
    const requestId = ++request.current;
    const isCurrent = () => generation === epoch.current && requestId === request.current;
    setBusy(true); setError('');
    let next: CameraProcessor | null = null;
    try {
      if (image && (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type) || image.size > 10 * 1024 * 1024)) throw new Error('Choose a JPG, PNG, or WebP image smaller than 10 MB.');
      const selectedImage = image ?? backgroundImage.current;
      const cameraTrack = capture.current?.getVideoTracks().find((track) => track.readyState === 'live');
      if (cameraTrack && choice !== 'none') {
        const controller = new AbortController(); processing.current = controller;
        next = await createCameraBackground(cameraTrack, choice, (message) => {
          if (!next || processor.current !== next) return;
          // A failed effect must not silently expose the real background.
          cameraTrack.stop(); processor.current?.stop(); processor.current = null;
          publishCapture(new MediaStream(capture.current?.getAudioTracks() ?? []));
          void syncSenders(); setError(`Camera background stopped. ${message}`);
        }, choice === 'custom' ? selectedImage : undefined, controller.signal, { rung: ceilingWith({ background: true }).background });
        if (processing.current === controller) processing.current = null;
      }
      if (!isCurrent()) { next?.stop(); return; }
      if (image) backgroundImage.current = image;
      const previous = processor.current;
      processor.current = next;
      backgroundChoice.current = choice; setBackground(choice);
      saveBackground(choice);
      if (image) void saveBackgroundImage(image);
      publishCapture(capture.current);
      await syncSenders();
      previous?.stop();
    } catch (failure) {
      next?.stop();
      if (isCurrent()) setError(`Could not apply camera background. ${failure instanceof Error ? failure.message : 'Please try again.'}`);
    } finally { if (isCurrent()) setBusy(false); }
  }, [ceilingWith, publishCapture, syncSenders]);

  // A filter held below the person's choice by the quality policy.
  const backgroundReduced = ladder.background && ceiling.background > 0;
  const noiseReduced = ladder.noise && ceiling.noise === 'standard';

  return { quality, chooseQuality, cameraOn, noiseLevel, noiseReduced, backgroundReduced, standardSupported, strongSupported, noiseActive, filtering, levelBusy, chooseNoiseLevel, background, chooseBackground, localStream, screenStream, screenBusy, startScreen, stopScreen, whiteboardActive, startWhiteboard, remoteMedia, chooseMedia, error, clearError, busy, hasChosenDevices: hasChosenDevices || answeredBefore };
}
