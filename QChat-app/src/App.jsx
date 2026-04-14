import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useWebRTC } from './hooks/useWebRTC';
import {
  createIdentity,
  getOrCreateSocketId,
  loadIdentity,
  normalizePublicIdInput,
  regeneratePublicId,
  saveIdentity,
  validatePublicIdFormat,
} from './services/identityService';
import { signalingService } from './services/signalingService';
import {
  MessageSquare,
  Phone,
  Video,
  Search,
  Copy,
  Mic,
  MicOff,
  Camera,
  CameraOff,
  PhoneOff,
  Users,
  Plus,
  LogIn,
  X,
  ChevronRight,
  Lock,
} from 'lucide-react';
import './App.css';

function App() {
  const [mode, setMode] = useState('chat');
  const [messageInput, setMessageInput] = useState('');
  const [messages, setMessages] = useState([
    { id: 1, text: 'Hey! Ready for the call?', sender: 'received', time: '10:12' },
    { id: 2, text: 'Yes, joining in 2 mins.', sender: 'sent', time: '10:13' },
    { id: 3, text: 'Great, I sent you the room code.', sender: 'received', time: '10:14' },
  ]);

  const [callFlow, setCallFlow] = useState('idle');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [setupMicEnabled, setSetupMicEnabled] = useState(true);
  const [setupCameraEnabled, setSetupCameraEnabled] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimerRef = useRef(null);
  const previewVideoRef = useRef(null);
  const previewStreamRef = useRef(null);

  const [identity, setIdentity] = useState(() => loadIdentity());
  const [identityState, setIdentityState] = useState(() => (loadIdentity() ? 'registered' : 'initializing'));
  const [identityError, setIdentityError] = useState('');

  const [searchOpen, setSearchOpen] = useState(false);
  const [lookupInput, setLookupInput] = useState('');
  const [lookupResult, setLookupResult] = useState(null);
  const [lookupState, setLookupState] = useState('idle');
  const [lookupError, setLookupError] = useState('');

  const [profileOpen, setProfileOpen] = useState(false);
  const [incomingInvite, setIncomingInvite] = useState(null);

  const socketIdRef = useRef(getOrCreateSocketId());
  const seenInviteIdsRef = useRef(new Set());

  const {
    callState, status, error, callId, setCallId,
    isMicEnabled, isCameraEnabled, remoteHasVideo,
    pendingJoinRequest, isCaller,
    localVideoRef, remoteVideoRef,
    initiateCall, answerCallById,
    admitJoinRequest, declineJoinRequest,
    endCallForSelf, endCallForAll,
    toggleMicrophone, toggleCamera,
  } = useWebRTC();

  const contacts = useMemo(() => [
    { id: '1', name: 'Priya', preview: 'See you in standup', active: true },
    { id: '2', name: 'Arjun', preview: 'Shared the latest build' },
    { id: '3', name: 'Neha', preview: 'Can we switch to video?' },
    { id: '4', name: 'Team Design', preview: 'Review at 4:30 PM' },
  ], []);

  useEffect(() => {
    if (callState === 'in-call') setCallFlow('in-meeting');
    if (callState === 'ended') setCallFlow('idle');
    if (callState === 'idle' && callFlow === 'in-meeting') setCallFlow('idle');
  }, [callState, callFlow]);

  /* ── Camera/mic preview for prejoin screen ── */
  const stopPreview = useCallback(() => {
    if (previewStreamRef.current) {
      previewStreamRef.current.getTracks().forEach((t) => t.stop());
      previewStreamRef.current = null;
    }
    if (previewVideoRef.current) previewVideoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    if (!callFlow.startsWith('prejoin')) return;
    const isAudio = mode === 'audio';
    let cancelled = false;
    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: isAudio ? false : { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        previewStreamRef.current = stream;
        if (previewVideoRef.current) previewVideoRef.current.srcObject = stream;
        const vt = stream.getVideoTracks()[0];
        const at = stream.getAudioTracks()[0];
        if (vt) vt.enabled = setupCameraEnabled;
        if (at) at.enabled = setupMicEnabled;
      } catch { /* permission denied or no device — toggling will show off state */ }
    };
    start();
    return () => { cancelled = true; stopPreview(); };
  }, [callFlow, mode, stopPreview]);

  useEffect(() => {
    if (!previewStreamRef.current) return;
    const at = previewStreamRef.current.getAudioTracks()[0];
    const vt = previewStreamRef.current.getVideoTracks()[0];
    if (at) at.enabled = setupMicEnabled;
    if (vt) vt.enabled = setupCameraEnabled;
  }, [setupMicEnabled, setupCameraEnabled]);

  const resetControlsTimer = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  useEffect(() => {
    if (callFlow !== 'in-meeting') return;
    resetControlsTimer();
    const onMove = () => resetControlsTimer();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchstart', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchstart', onMove);
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    };
  }, [callFlow, resetControlsTimer]);

  useEffect(() => {
    if (identity) return;
    const next = createIdentity();
    saveIdentity(next);
    setIdentity(next);
    setIdentityState('registered');
  }, [identity]);

  useEffect(() => {
    if (!identity) return;
    let active = true;
    const register = async () => {
      setIdentityState('registered');
      setIdentityError('');
      let candidate = identity;
      for (let i = 0; i < 5; i++) {
        try {
          await signalingService.registerUser({ ...candidate, socketId: socketIdRef.current });
          if (!active) return;
          setIdentity(candidate);
          saveIdentity(candidate);
          setIdentityState('connected');
          return;
        } catch (err) {
          const msg = err?.message || '';
          if (msg.toLowerCase().includes('conflict')) {
            candidate = { ...candidate, publicId: regeneratePublicId() };
            continue;
          }
          if (active) { setIdentityState('unregistered'); setIdentityError(msg || 'Unable to register.'); }
          return;
        }
      }
      if (active) { setIdentityState('unregistered'); setIdentityError('Unable to generate unique ID.'); }
    };
    register();
    return () => { active = false; };
  }, [identity]);

  useEffect(() => {
    if (!identity || identityState !== 'connected') return;
    const poll = async () => {
      try {
        const pending = await signalingService.getPendingCalls(socketIdRef.current);
        const next = pending.find((r) => !seenInviteIdsRef.current.has(r.requestId));
        if (!next) return;
        seenInviteIdsRef.current.add(next.requestId);
        setIncomingInvite(next);
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [identity, identityState]);

  useEffect(() => {
    const h = () => { signalingService.disconnect(socketIdRef.current).catch(() => {}); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  const sendMessage = () => {
    const t = messageInput.trim();
    if (!t) return;
    setMessages((p) => [...p, { id: Date.now(), text: t, sender: 'sent', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]);
    setMessageInput('');
  };
  const onMessageKeyDown = (e) => { if (e.key === 'Enter') { e.preventDefault(); sendMessage(); } };

  const onCreateMeeting = () => {
    setCallFlow('prejoin-create');
    setSetupMicEnabled(true);
    setSetupCameraEnabled(mode !== 'audio');
  };
  const onJoinMeeting = () => {
    if (!joinCodeInput.trim()) return;
    setCallId(joinCodeInput.trim());
    setCallFlow('prejoin-join');
    setSetupMicEnabled(true);
    setSetupCameraEnabled(mode !== 'audio');
  };
  const onConfirmPrejoin = async () => {
    stopPreview();
    const prefs = { micEnabled: setupMicEnabled, cameraEnabled: setupCameraEnabled };
    if (callFlow === 'prejoin-create') await initiateCall({ callType: mode === 'audio' ? 'audio' : 'video', mediaPrefs: prefs });
    else await answerCallById(callId, prefs);
  };
  const onCancelPrejoin = () => { stopPreview(); setCallFlow('idle'); };

  const onFindUser = async () => {
    const n = normalizePublicIdInput(lookupInput);
    if (!validatePublicIdFormat(n)) { setLookupError('Invalid format. Use 8 or 10 digits.'); setLookupResult(null); return; }
    setLookupError(''); setLookupState('searching');
    try {
      const u = await signalingService.findUser(n);
      setLookupResult(u); setLookupState('connected');
    } catch (e) { setLookupState('idle'); setLookupResult(null); setLookupError(e.message || 'User not found.'); }
  };
  const onNotifyUserToJoin = async () => {
    if (!lookupResult || !identity || !callId) { setLookupError('Create a meeting first.'); return; }
    try {
      await signalingService.callUser({ fromSocketId: socketIdRef.current, toPublicId: lookupResult.publicId, callCode: callId, callType: mode === 'audio' ? 'audio' : 'video' });
      setLookupError('Invite sent.');
    } catch (e) { setLookupError(e.message || 'Unable to send invite.'); }
  };
  const onAcceptInvite = async () => {
    if (!incomingInvite) return;
    await signalingService.respondToCall({ socketId: socketIdRef.current, requestId: incomingInvite.requestId, decision: 'accept' });
    setCallId(incomingInvite.callCode); setJoinCodeInput(incomingInvite.callCode);
    setMode(incomingInvite.callType === 'audio' ? 'audio' : 'video');
    setCallFlow('prejoin-join'); setIncomingInvite(null);
  };
  const onDeclineInvite = async () => {
    if (!incomingInvite) return;
    await signalingService.respondToCall({ socketId: socketIdRef.current, requestId: incomingInvite.requestId, decision: 'decline' });
    setIncomingInvite(null);
  };
  const copyPublicId = async () => { if (identity?.publicId) try { await navigator.clipboard.writeText(identity.publicId); } catch {} };
  const copyCallId = async () => { if (callId) try { await navigator.clipboard.writeText(callId); } catch {} };

  const getContextLabel = () => {
    if (mode === 'chat') return 'Direct Message';
    if (callFlow === 'in-meeting') return mode === 'audio' ? 'Audio Call' : 'Video Call';
    return mode === 'audio' ? 'Audio' : 'Video';
  };

  const renderIdleCard = () => (
    <div className="idle-card">
      <div className="idle-icon">{mode === 'audio' ? <Phone size={40} /> : <Video size={40} />}</div>
      <h2>{mode === 'audio' ? 'Audio Call' : 'Video Meeting'}</h2>
      <p className="idle-sub">Start a new meeting or join with a code</p>
      <div className="idle-actions">
        <button type="button" className="btn-primary" onClick={onCreateMeeting}><Plus size={16} /><span>Create Meeting</span></button>
        <div className="join-row">
          <input value={joinCodeInput} onChange={(e) => setJoinCodeInput(e.target.value)} placeholder="Enter meeting code" className="code-input" onKeyDown={(e) => { if (e.key === 'Enter') onJoinMeeting(); }} />
          <button type="button" className="btn-secondary" onClick={onJoinMeeting} disabled={!joinCodeInput.trim()}><LogIn size={16} /><span>Join</span></button>
        </div>
      </div>
      <div className="encryption-badge"><Lock size={12} /><span>End-to-end encrypted</span></div>
    </div>
  );

  const renderPrejoin = () => {
    const isCreate = callFlow === 'prejoin-create';
    const isAudio = mode === 'audio';
    return (
      <div className="prejoin-screen">
        {!isAudio && (
          <div className="prejoin-preview">
            <video ref={previewVideoRef} autoPlay playsInline muted className="prejoin-video" />
            {!setupCameraEnabled && <div className="prejoin-cam-off"><CameraOff size={32} /><span>Camera off</span></div>}
          </div>
        )}
        <div className="prejoin-sidebar">
          <h2>{isCreate ? 'Ready to start?' : 'Ready to join?'}</h2>
          {isCreate && callId && (
            <button type="button" className="room-pill" onClick={copyCallId}>
              <span className="code-mono">{callId}</span><Copy size={14} />
            </button>
          )}
          <div className="prejoin-toggles">
            <button type="button" className={`toggle-btn ${setupMicEnabled ? 'on' : 'off'}`} onClick={() => setSetupMicEnabled((v) => !v)}>
              {setupMicEnabled ? <Mic size={18} /> : <MicOff size={18} />}<span>{setupMicEnabled ? 'Mic on' : 'Mic off'}</span>
            </button>
            {!isAudio && (
              <button type="button" className={`toggle-btn ${setupCameraEnabled ? 'on' : 'off'}`} onClick={() => setSetupCameraEnabled((v) => !v)}>
                {setupCameraEnabled ? <Camera size={18} /> : <CameraOff size={18} />}<span>{setupCameraEnabled ? 'Camera on' : 'Camera off'}</span>
              </button>
            )}
          </div>
          <div className="prejoin-btns">
            <button type="button" className="btn-primary btn-lg" onClick={onConfirmPrejoin}>{isCreate ? 'Start Meeting' : 'Join Now'}</button>
            <button type="button" className="btn-ghost" onClick={onCancelPrejoin}>Cancel</button>
          </div>
          <div className="encryption-badge"><Lock size={12} /><span>End-to-end encrypted</span></div>
        </div>
      </div>
    );
  };

  const renderMeeting = () => {
    const isAudio = mode === 'audio';
    return (
      <div className="meeting-view">
        {isAudio ? (
          <div className="meeting-audio">
            <div className="speaker-avatar"><span>{identity?.username?.[0]?.toUpperCase() || 'U'}</span></div>
            <h3>{identity?.username || 'QChat User'}</h3>
            <p className="meeting-sub">{status}</p>
          </div>
        ) : (
          <div className="meeting-video">
            <video ref={remoteVideoRef} autoPlay playsInline className="remote-video" />
            {!remoteHasVideo && <div className="video-placeholder"><Users size={32} /><span>Waiting for video</span></div>}
            <video ref={localVideoRef} autoPlay playsInline muted className={`self-video ${!isCameraEnabled ? 'self-video-hidden' : ''}`} />
            {!isCameraEnabled && <div className="self-pip-off"><CameraOff size={16} /></div>}
          </div>
        )}
        <div className={`floating-bar ${controlsVisible ? 'visible' : ''}`}>
          <button type="button" className={`ctrl-btn ${!isMicEnabled ? 'ctrl-off' : ''}`} onClick={toggleMicrophone} aria-label="Toggle mic">
            {isMicEnabled ? <Mic size={20} /> : <MicOff size={20} />}
          </button>
          {!isAudio && (
            <button type="button" className={`ctrl-btn ${!isCameraEnabled ? 'ctrl-off' : ''}`} onClick={toggleCamera} aria-label="Toggle camera">
              {isCameraEnabled ? <Camera size={20} /> : <CameraOff size={20} />}
            </button>
          )}
          <button type="button" className="ctrl-btn ctrl-end" onClick={isCaller ? endCallForAll : endCallForSelf} aria-label="End call">
            <PhoneOff size={20} />
          </button>
        </div>
        {status && <p className="meeting-status-bar">{status}</p>}
      </div>
    );
  };

  const renderRight = () => {
    if (mode === 'chat') {
      return (
        <section className="panel chat-panel">
          <div className="messages-list">
            {messages.map((m) => (
              <div key={m.id} className={`message-row ${m.sender}`}>
                <div className="message-bubble"><p>{m.text}</p><span>{m.time}</span></div>
              </div>
            ))}
          </div>
          <div className="message-input-bar">
            <input type="text" value={messageInput} onChange={(e) => setMessageInput(e.target.value)} onKeyDown={onMessageKeyDown} placeholder="Type a message" />
            <button type="button" className="send-btn" onClick={sendMessage}><ChevronRight size={18} /></button>
          </div>
        </section>
      );
    }
    if (callFlow === 'idle') return renderIdleCard();
    if (callFlow.startsWith('prejoin')) return renderPrejoin();
    if (callFlow === 'in-meeting') return renderMeeting();
    return null;
  };

  return (
    <div className="app-shell">
      {pendingJoinRequest && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="modal"><h3>Join Request</h3><p><strong>{pendingJoinRequest.requesterName}</strong> wants to join your call.</p>
            <div className="modal-actions"><button type="button" className="btn-primary" onClick={admitJoinRequest}>Admit</button><button type="button" className="btn-danger" onClick={declineJoinRequest}>Decline</button></div>
          </div>
        </div>
      )}
      {incomingInvite && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="modal"><div className="modal-icon"><Phone size={24} /></div><h3>Incoming Call</h3>
            <p><strong>{incomingInvite.fromUsername}</strong> invited you to {incomingInvite.callType === 'audio' ? 'an audio' : 'a video'} call.</p>
            <div className="modal-actions"><button type="button" className="btn-primary" onClick={onAcceptInvite}>Accept</button><button type="button" className="btn-danger" onClick={onDeclineInvite}>Decline</button></div>
          </div>
        </div>
      )}
      {searchOpen && (
        <div className="overlay" role="dialog" aria-modal="true" onClick={() => setSearchOpen(false)}>
          <div className="search-modal" onClick={(e) => e.stopPropagation()}>
            <div className="search-header"><Search size={18} /><input autoFocus value={lookupInput} onChange={(e) => setLookupInput(e.target.value)} placeholder="Find user by Public ID" onKeyDown={(e) => { if (e.key === 'Enter') onFindUser(); }} /><button type="button" className="btn-icon" onClick={() => setSearchOpen(false)}><X size={18} /></button></div>
            {lookupState === 'searching' && <p className="search-status">Searching...</p>}
            {lookupError && <p className="search-error">{lookupError}</p>}
            {lookupResult && (
              <div className="search-result"><div className="search-result-info"><div className="avatar">{lookupResult.username?.[0]?.toUpperCase() || '?'}</div><div><strong>{lookupResult.username}</strong><span className="code-mono">{lookupResult.publicId}</span></div></div>
                <button type="button" className="btn-secondary btn-sm" onClick={onNotifyUserToJoin}>Send Invite</button></div>
            )}
          </div>
        </div>
      )}

      <header className="top-bar">
        <div className="top-left"><div className="app-logo">Q</div><span className="app-name">QChat</span></div>
        <div className="top-center">{getContextLabel()}</div>
        <div className="top-right">
          <button type="button" className="btn-icon" onClick={() => setSearchOpen(true)} aria-label="Search"><Search size={18} /></button>
          <span className={`status-dot ${identityState === 'connected' ? 'online' : 'connecting'}`} />
          <div className="profile-wrap">
            <button type="button" className="profile-btn" onClick={() => setProfileOpen((v) => !v)}>{identity?.username?.[0]?.toUpperCase() || 'U'}</button>
            {profileOpen && (
              <div className="profile-dd">
                <div className="profile-dd-head"><strong>{identity?.username || 'Guest'}</strong><span className="code-mono">{identity?.publicId || '...'}</span></div>
                <button type="button" onClick={() => { copyPublicId(); setProfileOpen(false); }}><Copy size={14} /> Copy ID</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className={`main-layout ${callFlow === 'in-meeting' ? 'meeting-active' : ''}`}>
        <aside className={`sidebar ${callFlow === 'in-meeting' ? 'sidebar-mini' : ''}`}>
          <div className="mode-tabs">
            <button type="button" className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}><MessageSquare size={16} /><span>Chat</span></button>
            <button type="button" className={mode === 'audio' ? 'active' : ''} onClick={() => setMode('audio')}><Phone size={16} /><span>Audio</span></button>
            <button type="button" className={mode === 'video' ? 'active' : ''} onClick={() => setMode('video')}><Video size={16} /><span>Video</span></button>
          </div>
          <div className="contacts-list">
            {contacts.map((c) => (
              <button key={c.id} type="button" className={`contact-item ${c.active ? 'active' : ''}`}>
                <div className="avatar">{c.name[0]}</div>
                <div className="contact-text"><strong>{c.name}</strong><span>{c.preview}</span></div>
              </button>
            ))}
          </div>
        </aside>
        <section className="right-panel">
          {renderRight()}
          {error && <p className="error-line">{error}</p>}
        </section>
      </main>
    </div>
  );
}

export default App;
