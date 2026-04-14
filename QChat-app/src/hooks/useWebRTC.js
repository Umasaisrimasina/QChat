import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { firestore } from '../firebase';
import { closePeerConnection, createPeerConnection } from '../services/webrtcService';

const generateClientId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `client-${crypto.randomUUID()}`;
  }

  return `client-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
};

const mapMediaError = (error) => {
  if (error?.name === 'NotAllowedError') {
    return 'Camera or microphone permission was denied.';
  }

  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return 'Required media device was not found.';
  }

  if (error?.name === 'NotReadableError') {
    return 'Media device is busy in another application.';
  }

  return 'Unable to access media devices. Please try again.';
};

const playJoinRequestTone = () => {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioContext.currentTime;

    const createBeep = (startAt) => {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.value = 880;

      gainNode.gain.setValueAtTime(0.0001, startAt);
      gainNode.gain.exponentialRampToValueAtTime(0.08, startAt + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.2);

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + 0.22);
    };

    createBeep(now + 0.02);
    createBeep(now + 0.32);
  } catch {
    // no-op if audio context cannot play
  }
};

export const useWebRTC = () => {
  const [callState, setCallState] = useState('idle');
  const [status, setStatus] = useState('Ready');
  const [error, setError] = useState('');
  const [callId, setCallId] = useState('');
  const [isMicEnabled, setIsMicEnabled] = useState(true);
  const [isCameraEnabled, setIsCameraEnabled] = useState(true);
  const [isCaller, setIsCaller] = useState(false);
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [pendingJoinRequest, setPendingJoinRequest] = useState(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const clientIdRef = useRef(generateClientId());
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(new MediaStream());
  const activeCallDocRef = useRef(null);
  const callUnsubscribeRef = useRef(null);
  const candidateUnsubscribeRef = useRef(null);
  const candidateTargetCollectionRef = useRef(null);
  const hostJoinRequestUnsubscribeRef = useRef(null);
  const myJoinRequestUnsubscribeRef = useRef(null);
  const soundedJoinRequestsRef = useRef(new Set());

  const cleanupMainSubscriptions = () => {
    if (callUnsubscribeRef.current) {
      callUnsubscribeRef.current();
      callUnsubscribeRef.current = null;
    }

    if (candidateUnsubscribeRef.current) {
      candidateUnsubscribeRef.current();
      candidateUnsubscribeRef.current = null;
    }
  };

  const cleanupJoinRequestSubscriptions = () => {
    if (hostJoinRequestUnsubscribeRef.current) {
      hostJoinRequestUnsubscribeRef.current();
      hostJoinRequestUnsubscribeRef.current = null;
    }

    if (myJoinRequestUnsubscribeRef.current) {
      myJoinRequestUnsubscribeRef.current();
      myJoinRequestUnsubscribeRef.current = null;
    }
  };

  const stopLocalStream = () => {
    if (!localStreamRef.current) {
      return;
    }

    localStreamRef.current.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
  };

  const resetRemoteStream = () => {
    remoteStreamRef.current.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current = new MediaStream();

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
    }

    setRemoteHasVideo(false);
  };

  const resetConnection = () => {
    closePeerConnection(peerConnectionRef.current);
    peerConnectionRef.current = null;
    candidateTargetCollectionRef.current = null;
  };

  const softEndCall = (message = 'Call ended.') => {
    cleanupMainSubscriptions();
    cleanupJoinRequestSubscriptions();
    resetConnection();
    stopLocalStream();
    resetRemoteStream();

    setCallState('ended');
    setStatus(message);
    setPendingJoinRequest(null);
    setIsMicEnabled(true);
    setIsCameraEnabled(true);

    setTimeout(() => {
      setCallState('idle');
      setStatus('Ready');
    }, 1000);
  };

  const createConnection = () => {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const peerConnection = createPeerConnection({
      onTrack: (event) => {
        event.streams[0].getTracks().forEach((track) => {
          remoteStreamRef.current.addTrack(track);
          if (track.kind === 'video') {
            setRemoteHasVideo(true);
          }
        });

        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remoteStreamRef.current;
        }
      },
      onIceCandidate: (event) => {
        if (!event.candidate || !candidateTargetCollectionRef.current) {
          return;
        }

        addDoc(candidateTargetCollectionRef.current, event.candidate.toJSON());
      },
      onConnectionStateChange: () => {
        const connectionState = peerConnection.connectionState;

        if (connectionState === 'connected') {
          setCallState('in-call');
          setStatus('Connected');
        }

        if (connectionState === 'failed' || connectionState === 'disconnected') {
          setStatus('Connection interrupted.');
        }
      },
    });

    peerConnectionRef.current = peerConnection;
    return peerConnection;
  };

  const attachLocalTracks = (stream) => {
    const peerConnection = createConnection();
    const currentSenders = peerConnection.getSenders();

    stream.getTracks().forEach((track) => {
      const sender = currentSenders.find((existing) => existing.track?.kind === track.kind);

      if (sender) {
        sender.replaceTrack(track);
      } else {
        peerConnection.addTrack(track, stream);
      }
    });
  };

  const startLocalMedia = async ({ audioOnly = false, micEnabled = true, cameraEnabled = true } = {}) => {
    try {
      setError('');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: audioOnly
          ? false
          : {
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
      });

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }

      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const audioTrack = stream.getAudioTracks()[0];
      const videoTrack = stream.getVideoTracks()[0];

      if (audioTrack) {
        audioTrack.enabled = micEnabled;
      }

      if (videoTrack) {
        videoTrack.enabled = !audioOnly && cameraEnabled;
      }

      setIsMicEnabled(audioTrack ? audioTrack.enabled : false);
      setIsCameraEnabled(videoTrack ? videoTrack.enabled : false);
      attachLocalTracks(stream);
      setStatus(audioOnly ? 'Audio ready' : 'Video and audio ready');

      return stream;
    } catch (mediaError) {
      const message = mapMediaError(mediaError);
      setError(message);
      setStatus(message);
      throw mediaError;
    }
  };

  const listenCallDocument = (callDocumentRef) => {
    cleanupMainSubscriptions();

    callUnsubscribeRef.current = onSnapshot(callDocumentRef, (snapshot) => {
      const data = snapshot.data();
      if (!data) {
        return;
      }

      if (data.status === 'rejected') {
        softEndCall('Call was rejected.');
        return;
      }

      if (data.status === 'ended') {
        softEndCall('Call ended by host.');
        return;
      }

      if (data.answer && !peerConnectionRef.current?.currentRemoteDescription) {
        const answerDescription = new RTCSessionDescription(data.answer);
        peerConnectionRef.current?.setRemoteDescription(answerDescription);
        setCallState('in-call');
        setStatus('Connected');
      }
    });
  };

  const watchCandidates = (collectionRef) => {
    candidateUnsubscribeRef.current = onSnapshot(collectionRef, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== 'added') {
          return;
        }

        const candidate = new RTCIceCandidate(change.doc.data());
        peerConnectionRef.current?.addIceCandidate(candidate);
      });
    });
  };

  const watchJoinRequestsAsHost = (callDocumentRef) => {
    if (hostJoinRequestUnsubscribeRef.current) {
      hostJoinRequestUnsubscribeRef.current();
    }

    const pendingQuery = query(collection(callDocumentRef, 'joinRequests'), where('status', '==', 'pending'));

    hostJoinRequestUnsubscribeRef.current = onSnapshot(pendingQuery, (snapshot) => {
      const [firstPending] = snapshot.docs;

      if (!firstPending) {
        setPendingJoinRequest(null);
        return;
      }

      if (!soundedJoinRequestsRef.current.has(firstPending.id)) {
        playJoinRequestTone();
        soundedJoinRequestsRef.current.add(firstPending.id);
      }

      const requestData = firstPending.data();
      setPendingJoinRequest({
        id: firstPending.id,
        requesterName: requestData.requesterName || 'Guest',
      });
      setStatus(`${requestData.requesterName || 'Guest'} requested to join.`);
    });
  };

  const initiateCall = async ({ callType = 'video', mediaPrefs = {} } = {}) => {
    const audioOnly = callType === 'audio';

    try {
      setCallState('calling');
      setIsCaller(true);
      setPendingJoinRequest(null);
      setStatus('Creating call...');

      await startLocalMedia({
        audioOnly,
        micEnabled: mediaPrefs.micEnabled ?? true,
        cameraEnabled: mediaPrefs.cameraEnabled ?? true,
      });

      const peerConnection = createConnection();
      const callDocumentRef = doc(collection(firestore, 'calls'));
      const offerCandidates = collection(callDocumentRef, 'offerCandidates');
      const answerCandidates = collection(callDocumentRef, 'answerCandidates');

      activeCallDocRef.current = callDocumentRef;
      candidateTargetCollectionRef.current = offerCandidates;
      setCallId(callDocumentRef.id);

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      await setDoc(callDocumentRef, {
        callerId: clientIdRef.current,
        callerName: 'Host',
        callType,
        status: 'calling',
        createdAt: serverTimestamp(),
        offer: {
          type: offer.type,
          sdp: offer.sdp,
        },
      });

      listenCallDocument(callDocumentRef);
      watchCandidates(answerCandidates);
      watchJoinRequestsAsHost(callDocumentRef);
      setStatus(`Call created. Share code: ${callDocumentRef.id}`);
    } catch {
      softEndCall('Unable to start call.');
    }
  };

  const completeAnswerAsGuest = async ({ targetCallId, callData, mediaPrefs = {} }) => {
    const callDocumentRef = doc(firestore, 'calls', targetCallId);

    const audioOnly = callData.callType === 'audio';
    try {
      await startLocalMedia({
        audioOnly,
        micEnabled: mediaPrefs.micEnabled ?? true,
        cameraEnabled: mediaPrefs.cameraEnabled ?? true,
      });
    } catch {
      setStatus('Proceeding without local camera/mic.');
    }

    const peerConnection = createConnection();
    const answerCandidates = collection(callDocumentRef, 'answerCandidates');
    const offerCandidates = collection(callDocumentRef, 'offerCandidates');

    activeCallDocRef.current = callDocumentRef;
    candidateTargetCollectionRef.current = answerCandidates;

    await peerConnection.setRemoteDescription(new RTCSessionDescription(callData.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    await updateDoc(callDocumentRef, {
      answer: {
        type: answer.type,
        sdp: answer.sdp,
      },
      status: 'in-call',
      answeredAt: serverTimestamp(),
      calleeId: clientIdRef.current,
    });

    listenCallDocument(callDocumentRef);
    watchCandidates(offerCandidates);

    setIsCaller(false);
    setCallState('in-call');
    setStatus('Connected');
  };

  const answerCallById = async (id, mediaPrefs = {}) => {
    const normalizedId = (id || '').trim();
    if (!normalizedId) {
      setStatus('Enter a valid call code.');
      return;
    }

    const callDocumentRef = doc(firestore, 'calls', normalizedId);
    const callSnapshot = await getDoc(callDocumentRef);
    const callData = callSnapshot.data();

    if (!callData?.offer || callData.status === 'ended') {
      setStatus('This call is unavailable.');
      return;
    }

    if (callData.callerId === clientIdRef.current) {
      setStatus('You are already the host of this call.');
      return;
    }

    setCallState('ringing');
    setCallId(normalizedId);
    setStatus('Join request sent. Waiting for host approval...');

    const joinRequestsRef = collection(callDocumentRef, 'joinRequests');
    const joinRequestRef = await addDoc(joinRequestsRef, {
      requesterId: clientIdRef.current,
      requesterName: 'Guest',
      status: 'pending',
      createdAt: serverTimestamp(),
    });

    if (myJoinRequestUnsubscribeRef.current) {
      myJoinRequestUnsubscribeRef.current();
    }

    myJoinRequestUnsubscribeRef.current = onSnapshot(joinRequestRef, async (snapshot) => {
      const requestData = snapshot.data();
      if (!requestData) {
        return;
      }

      if (requestData.status === 'declined') {
        setCallState('idle');
        setStatus('Host declined your request.');
        myJoinRequestUnsubscribeRef.current?.();
        myJoinRequestUnsubscribeRef.current = null;
        return;
      }

      if (requestData.status === 'admitted') {
        myJoinRequestUnsubscribeRef.current?.();
        myJoinRequestUnsubscribeRef.current = null;

        try {
          await completeAnswerAsGuest({ targetCallId: normalizedId, callData, mediaPrefs });
          await updateDoc(joinRequestRef, {
            status: 'joined',
            joinedAt: serverTimestamp(),
          });
        } catch {
          setCallState('idle');
          setStatus('Unable to join the call after approval.');
        }
      }
    });
  };

  const admitJoinRequest = async () => {
    if (!pendingJoinRequest || !activeCallDocRef.current) {
      return;
    }

    const requestRef = doc(activeCallDocRef.current, 'joinRequests', pendingJoinRequest.id);
    await updateDoc(requestRef, {
      status: 'admitted',
      admittedAt: serverTimestamp(),
      admittedBy: clientIdRef.current,
    });

    setStatus(`Admitted ${pendingJoinRequest.requesterName}.`);
    setPendingJoinRequest(null);
  };

  const declineJoinRequest = async () => {
    if (!pendingJoinRequest || !activeCallDocRef.current) {
      return;
    }

    const requestRef = doc(activeCallDocRef.current, 'joinRequests', pendingJoinRequest.id);
    await updateDoc(requestRef, {
      status: 'declined',
      declinedAt: serverTimestamp(),
      declinedBy: clientIdRef.current,
    });

    setStatus(`Declined ${pendingJoinRequest.requesterName}.`);
    setPendingJoinRequest(null);
  };

  const endCallForSelf = async () => {
    try {
      if (activeCallDocRef.current) {
        await updateDoc(activeCallDocRef.current, {
          lastAction: 'left',
          lastActionBy: clientIdRef.current,
          lastActionAt: serverTimestamp(),
        });
      }
    } catch {
      // no-op
    }

    softEndCall('You left the call.');
  };

  const endCallForAll = async () => {
    if (!activeCallDocRef.current || !isCaller) {
      return endCallForSelf();
    }

    try {
      await updateDoc(activeCallDocRef.current, {
        status: 'ended',
        endedBy: clientIdRef.current,
        endedAt: serverTimestamp(),
      });
    } catch {
      // no-op
    }

    softEndCall('Call ended for everyone.');
  };

  const toggleMicrophone = () => {
    const track = localStreamRef.current?.getAudioTracks?.()[0];
    if (!track) {
      setStatus('No microphone track available.');
      return;
    }

    track.enabled = !track.enabled;
    setIsMicEnabled(track.enabled);
    setStatus(track.enabled ? 'Microphone on' : 'Microphone muted');
  };

  const toggleCamera = () => {
    const track = localStreamRef.current?.getVideoTracks?.()[0];
    if (!track) {
      setStatus('No camera track available.');
      return;
    }

    track.enabled = !track.enabled;
    setIsCameraEnabled(track.enabled);
    if (track.enabled && localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
      localVideoRef.current.play?.().catch(() => {});
    }
    setStatus(track.enabled ? 'Camera on' : 'Camera off');
  };

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
    }
  }, []);

  // Re-attach both local and remote streams to video elements when call connects.
  // Media is acquired before the meeting view renders, so refs are null at that time.
  // Retry several times to cover React render timing.
  useEffect(() => {
    if (callState !== 'in-call') return;
    const attach = () => {
      if (localVideoRef.current && localStreamRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
      if (remoteVideoRef.current && remoteStreamRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
      }
    };
    const timers = [0, 50, 150, 500, 1000].map((d) => setTimeout(attach, d));
    return () => timers.forEach((t) => clearTimeout(t));
  }, [callState]);

  useEffect(() => {
    return () => {
      cleanupMainSubscriptions();
      cleanupJoinRequestSubscriptions();
      resetConnection();
      stopLocalStream();
      resetRemoteStream();
    };
  }, []);

  const canEndForAll = useMemo(() => isCaller && (callState === 'calling' || callState === 'in-call'), [isCaller, callState]);

  return {
    callState,
    status,
    error,
    callId,
    setCallId,
    isMicEnabled,
    isCameraEnabled,
    isCaller,
    remoteHasVideo,
    pendingJoinRequest,
    canEndForAll,
    localVideoRef,
    remoteVideoRef,
    startLocalMedia,
    initiateCall,
    answerCallById,
    admitJoinRequest,
    declineJoinRequest,
    endCallForSelf,
    endCallForAll,
    toggleMicrophone,
    toggleCamera,
  };
};
