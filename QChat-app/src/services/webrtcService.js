export const rtcServers = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
};

export const createPeerConnection = ({ onTrack, onIceCandidate, onConnectionStateChange }) => {
  const peerConnection = new RTCPeerConnection(rtcServers);

  peerConnection.ontrack = onTrack;
  peerConnection.onicecandidate = onIceCandidate;
  peerConnection.onconnectionstatechange = onConnectionStateChange;

  return peerConnection;
};

export const closePeerConnection = (peerConnection) => {
  if (!peerConnection) {
    return;
  }

  peerConnection.ontrack = null;
  peerConnection.onicecandidate = null;
  peerConnection.onconnectionstatechange = null;

  try {
    peerConnection.close();
  } catch {
    // no-op: defensive close
  }
};
