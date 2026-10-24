import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { CarpetChat } from './CarpetChat';
import { GameCanvas } from './GameCanvas';
import { world } from './world';
import type { Player } from './world';
import { Avatar } from './Avatar';
import { AvatarPicker } from './AvatarPicker';
import { readProfile, saveProfile } from './profile';
import { useGame } from './useGame';
import { usePeerMedia } from './usePeerMedia';
import type { NoiseLevel, RemoteMedia } from './usePeerMedia';
import { useSpeaking } from './useSpeaking';
import type { CameraBackground } from './cameraBackground';
import { videoQualities } from './videoQuality';
import { readMirrorSelfView, saveMirrorSelfView } from './selfView';
import { clampSplitWidth, readSplitWidth, saveSplitWidth, splitWidthMax, splitWidthMin } from './splitView';
import { Whiteboard } from './Whiteboard';

type IconName = 'screen' | 'mic' | 'camera' | 'expand' | 'split' | 'close' | 'arrow' | 'people' | 'exit' | 'check' | 'more';
type Layout = 'strip' | 'split' | 'full';
const reactions = [
  { emoji: '👋', label: 'Wave' }, { emoji: '👍', label: 'Thumbs up' },
  { emoji: '❤️', label: 'Love' }, { emoji: '😂', label: 'Laugh' },
  { emoji: '🎉', label: 'Celebrate' }, { emoji: '🤔', label: 'Thinking' },
];
function Icon({ name, off = false }: { name: IconName; off?: boolean }) {
  const paths: Record<IconName, ReactNode> = {
    screen: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8m-4-4v4m-4-11 4-4 4 4m-4-4v7" /></>,
    mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
    camera: <><rect x="3" y="6" width="12" height="12" rx="3" /><path d="m15 10 6-4v12l-6-4" /></>,
    expand: <path d="M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6" />,
    split: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M10 4v16" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    people: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5" /></>,
    exit: <><path d="M10 4H4v16h6m4-13 5 5-5 5m-6-5h11" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}{off && <path d="m3 3 18 18" strokeWidth="2" />}</svg>;
}

function Dialog({ children, title, description, className = '' }: { children: ReactNode; title: string; description?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.querySelector<HTMLElement>('input,button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')];
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, []);
  return <div className="dialog-backdrop"><div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`dialog ${className}`}>
    <h2>{title}</h2>{description && <p className="dialog-description">{description}</p>}{children}
  </div></div>;
}

function VideoTile({ player, stream, local, media, screen = false, mirror = false, selected, onSelect }: { selected: boolean; onSelect: () => void; player: Player; stream: MediaStream | null; local: boolean; media?: RemoteMedia; screen?: boolean; mirror?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const speaking = useSpeaking(stream, !screen && player.mic && (local || media?.status === 'connected'));
  const [playBlocked, setPlayBlocked] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    if (stream) void element.play().then(() => setPlayBlocked(false)).catch(() => setPlayBlocked(true));
    return () => { element.srcObject = null; };
  }, [stream]);
  const connectionLabel = local ? 'You' : media?.status === 'connected' ? '' : media?.status === 'failed' ? 'Cannot connect directly' : media?.status === 'disconnected' ? 'Disconnected' : 'Connecting…';
  return <div className={`video-tile ${(screen || player.camera) && stream ? 'has-video' : ''} ${screen ? 'screen-tile' : ''} ${selected ? 'is-selected' : ''} ${speaking ? 'is-speaking' : ''} ${local && !screen && mirror ? 'is-mirrored' : ''}`} data-testid={`${screen ? 'screen' : 'video'}-${local ? 'self' : 'peer'}`}>
    <div className="video-avatar"><Avatar avatar={player.avatar} customAvatar={player.customAvatar} size={64} /></div>
    <video ref={video} autoPlay playsInline muted={local || screen} aria-label={`${player.name}${local ? ' (you)' : ''} ${screen ? 'shared screen' : 'video'}`} />
    <div className="video-caption"><span>{player.name}{local && <small> (you)</small>}{screen && <small> · Screen</small>}</span><Icon name={screen ? "screen" : "mic"} off={!screen && !player.mic} /></div>
    {connectionLabel && !local && <span className="connection-label">{connectionLabel}</span>}
    <button className="select-video" aria-label={`${selected ? 'Unpin' : 'Pin'} ${player.name}${local ? ' (you)' : ''} ${screen ? 'shared screen' : 'video'}`} aria-pressed={selected} onClick={onSelect}><span className="pin-label">{selected ? 'Unpin' : 'Pin'}</span></button>
    {playBlocked && !local && <button className="play-audio" onClick={(event) => { event.stopPropagation(); void video.current?.play().then(() => setPlayBlocked(false)).catch(() => {}); }}>Play audio</button>}
  </div>;
}

// Shown beside a filter's control while device load holds it below the person's choice.
const reducedNote = 'Reduced to keep the call smooth.';

function BackgroundChoices({ value, busy, reduced, onChange }: { value: CameraBackground; busy: boolean; reduced: boolean; onChange: (choice: CameraBackground, image?: File) => Promise<void> }) {
  const upload = useRef<HTMLInputElement>(null);
  return <fieldset className="background-settings" disabled={busy}><legend>Camera background</legend>
    <div className="background-choices">{([{ id: 'none', label: 'None' }, { id: 'blur', label: 'Blur' }, { id: 'sky', label: 'Sky' }, { id: 'forest', label: 'Forest' }] as const).map(({ id, label }) =>
      <button type="button" key={id} className={`background-choice background-${id}`} aria-pressed={value === id} onClick={() => { void onChange(id); }}><span aria-hidden="true" />{label}</button>)}</div>
    <input ref={upload} type="file" accept="image/jpeg,image/png,image/webp" hidden aria-label="Background image" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onChange('custom', file); event.target.value = ''; }} />
    <button type="button" className="secondary-button background-upload" aria-pressed={value === 'custom'} onClick={() => upload.current?.click()}>Choose image…{value === 'custom' ? ' ✓' : ''}</button>
    {busy && <p role="status">Preparing camera…</p>}
    <p className="media-note reduced-note" role="status">{reduced ? reducedNote : ''}</p>
  </fieldset>;
}

type NoiseMedia = { noiseLevel: NoiseLevel; standardSupported: boolean; strongSupported: boolean; noiseActive: boolean | undefined; filtering: boolean; noiseReduced: boolean; levelBusy: boolean };

function NoiseLevels({ media, disabled, onChange }: { media: NoiseMedia; disabled: boolean; onChange: (level: NoiseLevel) => void }) {
  const levels = [
    { id: 'off', label: 'Off', detail: 'Your voice is sent without noise suppression.', unavailable: '' },
    { id: 'standard', label: 'Standard', detail: 'Your browser’s built-in noise suppression.', unavailable: media.strongSupported ? 'Unavailable in this browser. Strong still works, using its filter alone.' : 'Unavailable in this browser.' },
    { id: 'strong', label: 'Strong', detail: 'Adds a filter for typing, clatter and other steady noise. Uses more processing.', unavailable: 'Unavailable in this browser.' },
  ] as const;
  return <fieldset className="noise-levels" disabled={disabled}><legend>Noise level</legend>
    {levels.map(({ id, label, detail, unavailable }) => {
      const supported = id === 'off' || (id === 'standard' ? media.standardSupported : media.strongSupported);
      return <label key={id} className="noise-level"><input type="radio" name="noise-level" value={id} checked={media.noiseLevel === id} disabled={!supported} aria-label={label} aria-describedby={`noise-${id}-note`} onChange={() => onChange(id)} />
        <span><strong>{label}</strong><small id={`noise-${id}-note`}>{supported ? detail : unavailable}</small></span></label>;
    })}
    <p className="media-note reduced-note" role="status">{media.noiseReduced ? reducedNote : ''}</p>
  </fieldset>;
}

// Reports what is actually applied, which can differ from the choice while a change is
// pending or in browsers that do not apply built-in suppression to a live microphone.
function noiseNote(media: NoiseMedia, micOn: boolean) {
  if (!micOn) return 'Your microphone is off. This choice applies when you turn it on.';
  if (media.levelBusy) return 'Changing the noise level…';
  // Held at Standard under load, the filter runs but passes the microphone through.
  const strong = media.filtering && !media.noiseReduced ? 'Strong noise filtering is active' : '';
  if (!media.standardSupported) {
    if (strong) return `${strong}. This browser has no built-in suppression, so the filter works alone.`;
    return 'Noise suppression is off. This browser has no built-in suppression.';
  }
  if (media.noiseActive === undefined) return `${strong ? `${strong}. Your` : 'Your'} browser does not report whether its built-in noise suppression is active.`;
  if (media.noiseActive !== (media.noiseLevel !== 'off')) {
    return `${strong ? `${strong}, but built-in` : 'Built-in'} noise suppression is currently ${media.noiseActive ? 'on' : 'off'}. Turn your microphone off and on to apply your choice; some browsers require this.`;
  }
  if (strong) return `${strong}, on top of built-in noise suppression.`;
  return media.noiseActive ? 'Standard noise suppression is active.' : 'Noise suppression is off.';
}

export default function App() {
  const game = useGame();
  const self = game.players.find((player) => player.id === game.selfId);
  const carpet = world.carpets.find((item) => item.id === self?.carpetId);
  const media = usePeerMedia(self, game.players, game.send, game.signalHandler, game.rejoined);
  const [saved] = useState(readProfile);
  const [name, setName] = useState(saved.name);
  const [avatar, setAvatar] = useState(saved.avatar);
  const [customAvatar, setCustomAvatar] = useState(saved.customAvatar);
  const [customOption, setCustomOption] = useState(saved.customOption || saved.customAvatar);
  const receiveAvatar = useCallback((id: string) => { setCustomAvatar(id); setCustomOption(id); }, []);
  const picker = <AvatarPicker avatar={avatar} customAvatar={customAvatar} customOption={customOption} onChange={(index, id) => { setAvatar(index); setCustomAvatar(id); }} onUpload={receiveAvatar} />;
  const [editingProfile, setEditingProfile] = useState(false);
  const [editingBackground, setEditingBackground] = useState(false);
  const [editingMicrophone, setEditingMicrophone] = useState(false);
  const [editingVideo, setEditingVideo] = useState(false);
  const [mirrorSelfView, setMirrorSelfView] = useState(readMirrorSelfView);
  const chooseMirrorSelfView = (mirror: boolean) => { setMirrorSelfView(mirror); saveMirrorSelfView(mirror); };
  const [whiteboardOpen, setWhiteboardOpen] = useState(false);
  const [promptCarpet, setPromptCarpet] = useState('');
  const [layout, setLayout] = useState<Layout>('strip');
  const [fullFrom, setFullFrom] = useState<Exclude<Layout, 'full'>>('strip');
  const [selectedTile, setSelectedTile] = useState('');
  const [splitWidth, setSplitWidth] = useState(readSplitWidth);
  const stage = useRef<HTMLDivElement>(null);
  const previousCarpet = useRef('');
  const connected = game.status === 'connected';
  const reconnecting = game.status === 'reconnecting';
  const members = self?.carpetId ? game.players.filter((player) => player.carpetId === self.carpetId).sort((a, b) => a.id === self.id ? -1 : b.id === self.id ? 1 : a.name.localeCompare(b.name)) : [];

  const screenMembers = members.filter((player) => player.id === self?.id ? !!media.screenStream : player.screen);
  const tileIds = [...screenMembers.map((player) => `screen-${player.id}`), ...members.map((player) => player.id)];
  const activeTile = layout !== 'strip' && tileIds.includes(selectedTile) ? selectedTile : undefined;
  const changeLayout = (next: Layout) => {
    if (next === 'strip' || layout === 'strip') setSelectedTile('');
    if (next === 'full') setFullFrom(layout === 'split' ? 'split' : 'strip');
    setLayout(next);
  };
  const selectTile = (id: string) => { if (layout === 'strip') { changeLayout('full'); setSelectedTile(id); } else setSelectedTile(activeTile === id ? '' : id); };
  const chooseSplitWidth = (width: number) => { const next = clampSplitWidth(Math.round(width)); setSplitWidth(next); saveSplitWidth(next); };
  const dragDivider = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = stage.current?.getBoundingClientRect();
    if (bounds && event.currentTarget.hasPointerCapture(event.pointerId)) chooseSplitWidth((event.clientX - bounds.left) / bounds.width * 100);
  };
  const nudgeDivider = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowLeft' ? -5 : event.key === 'ArrowRight' ? 5 : 0;
    if (!step) return;
    event.preventDefault();
    chooseSplitWidth(splitWidth + step);
  };

  useEffect(() => {
    if (layout !== 'full') return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setLayout(fullFrom); if (fullFrom === 'strip') setSelectedTile(''); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [layout, fullFrom]);

  useEffect(() => {
    const id = self?.carpetId ?? '';
    if (previousCarpet.current !== id) {
      previousCarpet.current = id;
      setLayout('strip');
      setSelectedTile('');
    }
    setPromptCarpet(id && !media.hasChosenDevices ? id : '');
  }, [self?.carpetId, media.hasChosenDevices]);

  const join = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) { saveProfile({ name: name.trim(), avatar, customAvatar, customOption }); game.join(name.trim(), avatar, customAvatar); }
  };

  async function chooseDevices(mic: boolean, camera: boolean) {
    const id = promptCarpet;
    if (await media.chooseMedia(mic, camera)) setPromptCarpet((current) => current === id ? '' : current);
  }

  const wasWhiteboardActive = useRef(false);
  useEffect(() => {
    if (wasWhiteboardActive.current && !media.whiteboardActive) setWhiteboardOpen(false);
    wasWhiteboardActive.current = media.whiteboardActive;
  }, [media.whiteboardActive]);

  const isMediaPrompt = !!promptCarpet && promptCarpet === self?.carpetId;
  const modalOpen = !connected || editingProfile || editingBackground || editingMicrophone || editingVideo || isMediaPrompt;
  const settingsOpen = editingMicrophone && connected && !!self;
  const backgroundOpen = editingBackground && connected && !!self;
  const videoOpen = editingVideo && connected && !!self;

  // Every dialog that shows the device error in itself. One open keeps that
  // error out of the banner; once one goes away by any route, the error was
  // already seen there, so it is cleared rather than following the person into
  // the banner. The render that removes the dialog keeps it out of the alert
  // banner too, so it is never painted or announced before it is cleared.
  const deviceDialogs = { microphone: settingsOpen, video: videoOpen, background: backgroundOpen, devices: isMediaPrompt };
  type DeviceDialog = keyof typeof deviceDialogs;
  const deviceDialogOpen = Object.values(deviceDialogs).some(Boolean);
  const previousDialogs = useRef(deviceDialogs);
  const deviceDialogClosed = (Object.keys(deviceDialogs) as DeviceDialog[]).some((dialog) => previousDialogs.current[dialog] && !deviceDialogs[dialog]);
  const { clearError: clearMediaError } = media;
  useLayoutEffect(() => {
    previousDialogs.current = deviceDialogs;
    if (deviceDialogClosed) clearMediaError();
  });

  const bannerError = connected ? game.serverError || (!deviceDialogOpen && !deviceDialogClosed ? media.error : '') : '';
  const dismissBanner = () => { if (game.serverError) game.clearServerError(); else clearMediaError(); };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><h1>Bespingle</h1></div>
      <div className="topbar-right"><span className="online-count"><i className={connected ? 'online-dot' : 'offline-dot'} />{game.players.length} online</span>
        {self && <button className="profile-button" onClick={() => { setName(self.name); setAvatar(self.avatar); setCustomAvatar(self.customAvatar || ''); setEditingProfile(true); }} aria-label="Edit profile"><Avatar avatar={self.avatar} customAvatar={self.customAvatar} size={35} /><span>{self.name}</span><span className="profile-chevron">⌄</span></button>}
      </div>
    </header>

    <main className="game-area" data-testid="game-area" aria-label="Game area">
      <div ref={stage} className={`game-stage ${layout === 'split' ? 'is-split' : ''}`}>
        <section className={`call-strip ${carpet ? 'has-conversation' : 'is-quiet'} ${layout === 'full' ? 'expanded' : layout === 'split' ? 'split' : ''}`} style={layout === 'split' ? { flexBasis: `${splitWidth}%` } : undefined} aria-label="Conversation videos">
          <div className="conversation">
            {carpet ? <>
              <div className="conversation-heading"><span className="room-dot" style={{ background: carpet.color }} /><strong>{carpet.name}</strong><span className="conversation-count">{members.length} here</span>
                {activeTile && <button className="gallery-button" onClick={() => setSelectedTile('')}>Show all videos</button>}
                {layout === 'strip' && <button className="expand-button" aria-label="Side by side" aria-pressed={false} onClick={() => changeLayout('split')}><Icon name="split" /><span>Side by side</span></button>}
                {layout === 'full' ? <button className="expand-button" aria-label="Back to game" onClick={() => changeLayout(fullFrom)}><Icon name="close" /><span>Back to game</span></button>
                  : <button className="expand-button" aria-label="Expand" aria-pressed={false} onClick={() => changeLayout('full')}><Icon name="expand" /><span>Expand</span></button>}
                {layout === 'split' && <button className="expand-button" aria-label="Back to strip" onClick={() => changeLayout('strip')}><Icon name="close" /><span>Back to strip</span></button>}
              </div>
              <div className={`video-layout ${activeTile ? 'has-pin' : 'gallery'}`}><div className="video-grid" aria-label="Pin or unpin a video">
                {screenMembers.map((player) => <VideoTile key={`screen-${player.id}`} selected={activeTile === `screen-${player.id}`} onSelect={() => selectTile(`screen-${player.id}`)} player={player} local={player.id === self?.id} screen stream={player.id === self?.id ? media.screenStream : media.remoteMedia[player.id]?.screenStream ?? null} media={media.remoteMedia[player.id]} />)}
                {members.map((player) => <VideoTile key={player.id} selected={activeTile === player.id} onSelect={() => selectTile(player.id)} player={player} local={player.id === self?.id} mirror={mirrorSelfView} stream={player.id === self?.id ? media.localStream : media.remoteMedia[player.id]?.stream ?? null} media={media.remoteMedia[player.id]} />)}
              </div></div>
              {layout === 'full' && <p className="expanded-hint">You’re still in {carpet.name}. Return to the game to move.</p>}
            </> : <div className="quiet-floor"><Icon name="people" /><span>Walk onto a carpet to start a conversation.</span><span className={`quiet-status ${self?.mic || media.cameraOn ? 'is-enabled' : ''}`}><i />{self?.mic && media.cameraOn ? 'Mic & camera on' : self?.mic ? 'Microphone on' : media.cameraOn ? 'Camera on' : 'Devices off'}</span></div>}
          </div>
        </section>
        {layout === 'split' && <div className="split-divider" role="separator" aria-orientation="vertical" aria-label="Resize conversation videos" aria-valuenow={splitWidth} aria-valuemin={splitWidthMin} aria-valuemax={splitWidthMax} tabIndex={0} onKeyDown={nudgeDivider} onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={dragDivider} />}
        <div className="play-space"><div className="game-viewport"><GameCanvas players={game.players} selfId={game.selfId} onMove={game.move} onCancelMove={game.cancelMove} onDance={() => game.send({ type: 'dance' })} serverNow={game.serverNow} disabled={modalOpen || layout === 'full'} /></div>
          {connected && carpet && <CarpetChat key={`${game.selfId}:${carpet.id}`} carpet={carpet} messages={game.messages} selfId={game.selfId} send={game.send} />}
        </div>
      </div>
      {reconnecting ? <footer className="game-hud reconnecting-hud">
        <div className="reconnecting-banner" role="status"><span className="reconnecting-dot" aria-hidden="true" /><strong>Reconnecting…</strong><span>You’ll be back where you were as soon as the office answers.</span></div>
        <button type="button" className="secondary-button" onClick={game.leave}>Leave</button>
      </footer> : <footer className="game-hud">
        <div className="location-info"><span className="location-dot" style={{ background: carpet?.color ?? '#a0aa9d' }} /><div><strong>{carpet?.name ?? 'Open floor'}</strong><span>{carpet ? `${members.length} in conversation` : 'No active conversation'}</span></div></div>
        <div className="media-controls"><div className={`device-group ${self?.mic ? 'enabled' : ''}`} role="group" aria-label="Microphone">
            <button className={self?.mic ? 'device-button enabled' : 'device-button'} disabled={!connected || media.busy || isMediaPrompt} aria-label={self?.mic ? 'Turn microphone off' : 'Turn microphone on'} aria-pressed={self?.mic ?? false} onClick={() => { void media.chooseMedia(!self?.mic, media.cameraOn); }}><Icon name="mic" off={!self?.mic} /><span>{self?.mic ? 'Mic on' : 'Mic off'}</span></button>
            <button className={`device-button device-more ${self?.mic ? 'enabled' : ''}`} disabled={!connected || media.busy || isMediaPrompt} aria-label="Microphone settings" aria-haspopup="dialog" title="Microphone settings" onClick={() => setEditingMicrophone(true)}><Icon name="more" /></button>
          </div>
          <div className={`device-group ${media.cameraOn ? 'enabled' : ''}`} role="group" aria-label="Camera">
            <button className={media.cameraOn ? 'device-button enabled' : 'device-button'} disabled={!connected || media.busy || isMediaPrompt} aria-label={media.cameraOn ? 'Turn camera off' : 'Turn camera on'} aria-pressed={media.cameraOn} onClick={() => { void media.chooseMedia(self?.mic ?? false, !media.cameraOn); }}><Icon name="camera" off={!media.cameraOn} /><span>{media.cameraOn ? media.quality === 'audio' ? 'Camera paused' : 'Camera on' : 'Camera off'}</span></button>
            <button className={`device-button device-more ${media.cameraOn ? 'enabled' : ''}`} disabled={!connected || media.busy || isMediaPrompt} aria-label="Video settings" aria-haspopup="dialog" title="Video settings" onClick={() => setEditingVideo(true)}><Icon name="more" /></button>
          </div>
          <button className={`device-button ${media.background !== 'none' ? 'enabled' : ''}`} disabled={!connected || media.busy || isMediaPrompt} aria-label="Camera background" onClick={() => setEditingBackground(true)}><Icon name="camera" /><span>Background</span></button>
          <button className={`device-button ${media.screenStream && !media.whiteboardActive ? 'enabled' : ''}`} disabled={!connected || !carpet || media.screenBusy || media.whiteboardActive || isMediaPrompt} aria-label={media.screenStream && !media.whiteboardActive ? 'Stop sharing screen' : 'Share screen'} aria-pressed={!!media.screenStream && !media.whiteboardActive} title={carpet ? 'Share a tab, window, or screen with this carpet' : 'Walk onto a carpet to share your screen'} onClick={() => { if (media.screenStream) media.stopScreen(); else void media.startScreen(); }}><Icon name="screen" /><span>{media.screenBusy ? 'Choosing screen…' : media.screenStream && !media.whiteboardActive ? 'Stop sharing' : 'Share screen'}</span></button>
          <button className={`device-button ${media.whiteboardActive ? 'enabled' : ''}`} disabled={!connected || !carpet || (!!media.screenStream && !media.whiteboardActive) || isMediaPrompt} aria-label={media.whiteboardActive ? 'Close whiteboard' : 'Open whiteboard'} aria-pressed={media.whiteboardActive} title={carpet ? 'Draw on a shared whiteboard' : 'Walk onto a carpet to use the whiteboard'} onClick={() => { if (media.whiteboardActive) { media.stopScreen(); } else { setWhiteboardOpen(true); } }}><Icon name="screen" /><span>{media.whiteboardActive ? 'Close board' : 'Whiteboard'}</span></button>
          <span className="hud-divider" /><button className="leave-button" disabled={!connected} onClick={game.leave} aria-label="Leave office"><Icon name="exit" /></button>
        </div>
        <div className="movement-hint"><span><kbd>W</kbd><span><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span></span><span>WASD or arrow keys to walk<small>Double-click to portal / swap · Shift to sprint · Z to dance · Scroll to zoom</small></span></div>
        <div className="emoji-bar" role="group" aria-label="Emoji reactions">
          {reactions.map(({ emoji, label }) => <button key={emoji} type="button" className="emoji-button" disabled={!connected || modalOpen} aria-label={`React: ${label}`} title={label} onClick={() => game.send({ type: 'reaction', emoji })}><span aria-hidden="true">{emoji}</span></button>)}
        </div>
      </footer>}
      {bannerError && <div key={game.serverError ? `server-${game.serverErrorId}` : 'media'} className="inline-error" role="alert"><span>{bannerError}</span><button type="button" className="inline-error-close" aria-label="Dismiss error" title="Dismiss" onClick={dismissBanner}><Icon name="close" /></button></div>}
    </main>

    {!connected && !reconnecting && <Dialog title="Make yourself at home." description="Pick a familiar face, add your name, and step into the office." className="join-dialog">
      <span className="welcome-pixel" aria-hidden="true"><Avatar avatar={avatar} customAvatar={customAvatar} size={88} /></span>
      <form onSubmit={join}><label className="field-label" htmlFor="display-name">Your display name</label><input id="display-name" maxLength={32} required autoComplete="off" placeholder="What should we call you?" value={name} onChange={(event) => setName(event.target.value)} disabled={game.status === 'connecting'} />
        {picker}
        {game.error && <p className="form-error" role="alert">{game.error}</p>}
        <button className="primary-button" disabled={!name.trim() || game.status === 'connecting'}>{game.status === 'connecting' ? 'Opening the door…' : 'Enter the office'}<Icon name="arrow" /></button>
      </form><p className="join-note"><Icon name="mic" off /><Icon name="camera" off />Your microphone and camera start off.</p>
    </Dialog>}

    {editingProfile && self && <Dialog title="Your profile" description="This is how your name appears around the office."><form onSubmit={(event) => { event.preventDefault(); if (name.trim()) { saveProfile({ name: name.trim(), avatar, customAvatar, customOption }); game.send({ type: 'profile', name: name.trim(), avatar, customAvatar }); setEditingProfile(false); } }}><div className="profile-preview"><Avatar avatar={avatar} customAvatar={customAvatar} size={70} /></div><label className="field-label" htmlFor="profile-name">Display name</label><input id="profile-name" maxLength={32} value={name} onChange={(event) => setName(event.target.value)} required />{picker}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => setEditingProfile(false)}>Cancel</button><button className="primary-button" disabled={!name.trim()}>Save profile<Icon name="check" /></button></div></form></Dialog>}

    {settingsOpen && self && <Dialog title="Microphone settings" description="Reduce background noise so others can hear your voice more clearly.">
      <NoiseLevels media={media} disabled={media.busy || media.levelBusy} onChange={(level) => { void media.chooseNoiseLevel(level); }} />
      <p className="media-note" role="status">{noiseNote(media, self.mic)}</p>
      <p className="media-note">Echo cancellation and automatic volume adjustment are also requested. Processing happens on your device. Your noise choice is remembered in this browser.</p>
      {media.error && <p className="form-error" role="alert">{media.error}</p>}
      <div className="form-actions"><button className="primary-button" disabled={media.busy || media.levelBusy} onClick={() => setEditingMicrophone(false)}>Done<Icon name="check" /></button></div>
    </Dialog>}

    {videoOpen && self && <Dialog title="Video settings" description="Choose how much video you send.">
      <fieldset className="quality-settings"><legend>Video quality</legend>
        {videoQualities.map(({ id, label, detail }) => <label key={id} className="quality-choice"><input type="radio" name="video-quality" value={id} aria-label={label} aria-describedby={`quality-${id}`} checked={media.quality === id} onChange={() => media.chooseQuality(id)} /><span><strong>{label}</strong><small id={`quality-${id}`}>{detail}</small></span></label>)}
      </fieldset>
      {media.cameraOn && <div className="self-view-preview"><VideoTile player={{ ...self, camera: true }} stream={media.localStream} local mirror={mirrorSelfView} selected={false} onSelect={() => {}} /></div>}
      <label className="noise-setting"><input type="checkbox" checked={mirrorSelfView} onChange={(event) => chooseMirrorSelfView(event.target.checked)} />Mirror my video</label>
      <p className="media-note">{media.quality === 'audio' ? 'Your camera keeps running on your device but is not sent, so others see your avatar. Audio and screen sharing continue.' : 'Your video quality choice is remembered in this browser.'} Mirroring changes only how you see yourself; others always see your true image.</p>
      {media.error && <p className="form-error" role="alert">{media.error}</p>}
      <div className="form-actions"><button className="primary-button" disabled={media.busy} onClick={() => setEditingVideo(false)}>Done<Icon name="check" /></button></div>
    </Dialog>}

    {backgroundOpen && self && <Dialog title="Camera background" description="Keep your surroundings private with blur or a virtual background.">
      {media.cameraOn ? <div className="background-preview"><VideoTile player={{ ...self, camera: true }} stream={media.localStream} local mirror={mirrorSelfView} selected={false} onSelect={() => {}} /></div> : <p className="media-note">Choose a background before turning on your camera.</p>}
      <BackgroundChoices value={media.background} busy={media.busy} reduced={media.backgroundReduced} onChange={media.chooseBackground} />
      {media.error && <p className="form-error" role="alert">{media.error}</p>}
      <p className="media-note">Your background is applied on your device and is visible to everyone in your conversation.</p>
      <div className="form-actions"><button className="primary-button" onClick={() => setEditingBackground(false)}>Done<Icon name="check" /></button></div>
    </Dialog>}

    {isMediaPrompt && <Dialog title={`You're in ${carpet?.name ?? 'a conversation'}.`} description="What would you like to enable? You can hear and see others with your own devices off." className="media-dialog">
      <BackgroundChoices value={media.background} busy={media.busy} reduced={media.backgroundReduced} onChange={media.chooseBackground} />
      <div className="device-choices">
        <button disabled={media.busy} onClick={() => { void chooseDevices(true, true); }}><span className="choice-icons"><Icon name="mic" /><Icon name="camera" /></span><strong>Both</strong><span>Microphone & camera</span></button>
        <button disabled={media.busy} onClick={() => { void chooseDevices(true, false); }}><span className="choice-icons"><Icon name="mic" /></span><strong>Microphone only</strong><span>Join with your voice</span></button>
        <button disabled={media.busy} onClick={() => { void chooseDevices(false, true); }}><span className="choice-icons"><Icon name="camera" /></span><strong>Video only</strong><span>Keep your microphone off</span></button>
        <button disabled={media.busy} onClick={() => { void chooseDevices(false, false); }}><span className="choice-icons"><Icon name="people" /></span><strong>Neither</strong><span>Just listen and watch</span></button>
      </div>{media.busy && <p className="permission-hint" role="status">Check your browser's device permission request…</p>}{media.error && <p className="form-error" role="alert">{media.error}</p>}<p className="media-note">Device settings stay the same until you change them or leave the game.</p>
    </Dialog>}

    {whiteboardOpen && <Whiteboard onStream={(stream) => media.startWhiteboard(stream)} onClose={() => { if (media.whiteboardActive) media.stopScreen(); setWhiteboardOpen(false); }} />}
  </div>;
}
