import { useState, useRef } from 'react';
import { firestore } from './firebase';
import { collection, doc, addDoc, getDoc, updateDoc, onSnapshot, setDoc } from 'firebase/firestore';
import './App.css';

const servers = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
};

let pc = new RTCPeerConnection(servers);

function App() {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(new MediaStream());
  const [callId, setCallId] = useState('');
  const [status, setStatus] = useState('');
  const webcamVideo = useRef(null);
  const remoteVideo = useRef(null);

  const startWebcam = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    setLocalStream(stream);
    webcamVideo.current.srcObject = stream;

    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });

    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        remoteStream.addTrack(track);
      });
    };

    remoteVideo.current.srcObject = remoteStream;

    setStatus('Webcam started');
  };

  const createCall = async () => {
    const callDocRef = doc(collection(firestore, 'calls'));
    const offerCandidates = collection(callDocRef, 'offerCandidates');
    const answerCandidates = collection(callDocRef, 'answerCandidates');

    setCallId(callDocRef.id);
    setStatus(`Call created. Share this code: ${callDocRef.id}`);

    pc.onicecandidate = (event) => {
      event.candidate && addDoc(offerCandidates, event.candidate.toJSON());
    };

    const offerDescription = await pc.createOffer();
    await pc.setLocalDescription(offerDescription);

    const offer = {
      sdp: offerDescription.sdp,
      type: offerDescription.type,
    };

    await setDoc(callDocRef, { offer });

    onSnapshot(callDocRef, (snapshot) => {
      const data = snapshot.data();
      if (!pc.currentRemoteDescription && data?.answer) {
        const answerDescription = new RTCSessionDescription(data.answer);
        pc.setRemoteDescription(answerDescription);
        console.log('Call answered with remote description:', data.answer);
        setStatus('Call answered by remote peer.');
      }
    });

    onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          pc.addIceCandidate(candidate);
        }
      });
    });
  };

  const answerCall = async () => {
    console.log('Answering call with code:', callId);
    const callDocRef = doc(firestore, 'calls', callId);
    const answerCandidates = collection(callDocRef, 'answerCandidates');
    const offerCandidates = collection(callDocRef, 'offerCandidates');

    pc.onicecandidate = (event) => {
      event.candidate && addDoc(answerCandidates, event.candidate.toJSON());
    };

    const callDoc = await getDoc(callDocRef);
    const callData = callDoc.data();

    const offerDescription = callData.offer;
    await pc.setRemoteDescription(new RTCSessionDescription(offerDescription));

    const answerDescription = await pc.createAnswer();
    await pc.setLocalDescription(answerDescription);

    const answer = {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
    };

    await updateDoc(callDocRef, { answer });
  console.log('Answer sent to Firestore.');
  setStatus('Answer sent. Waiting for media...');

    onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          let data = change.doc.data();
          pc.addIceCandidate(new RTCIceCandidate(data));
          console.log('Received ICE candidate from caller:', data);
        }
      });
    });
  };

  return (
    <div className="App">
      <div className="videos">
        <video ref={webcamVideo} autoPlay playsInline muted></video>
        <video ref={remoteVideo} autoPlay playsInline></video>
      </div>

      <div className="controls">
        <button onClick={startWebcam}>Start Webcam</button>
        <button onClick={createCall}>Create Call</button>
        <input value={callId} onChange={(e) => setCallId(e.target.value)} placeholder="Join with code" />
        <button onClick={answerCall}>Answer</button>
        {status && <p className="status">{status}</p>}
      </div>
    </div>
  );
}

export default App;
