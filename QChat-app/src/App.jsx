import { useMemo, useState, useRef } from 'react';
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
  const [mode, setMode] = useState('chat');
  const [messageInput, setMessageInput] = useState('');
  const [messages, setMessages] = useState([
    { id: 1, text: 'Hey! Ready for the call?', sender: 'received', time: '10:12' },
    { id: 2, text: 'Yes, joining in 2 mins.', sender: 'sent', time: '10:13' },
    { id: 3, text: 'Great, I sent you the room code.', sender: 'received', time: '10:14' },
  ]);
  const webcamVideo = useRef(null);
  const remoteVideo = useRef(null);

  const contacts = useMemo(
    () => [
      { id: '1', name: 'Priya', preview: 'See you in standup', active: true },
      { id: '2', name: 'Arjun', preview: 'Shared the latest build' },
      { id: '3', name: 'Neha', preview: 'Can we switch to video?' },
      { id: '4', name: 'Team Design', preview: 'Review at 4:30 PM' },
    ],
    []
  );

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

  const sendMessage = () => {
    const trimmed = messageInput.trim();
    if (!trimmed) {
      return;
    }

    setMessages((previous) => [
      ...previous,
      {
        id: Date.now(),
        text: trimmed,
        sender: 'sent',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
    setMessageInput('');
  };

  const onMessageKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendMessage();
    }
  };

  const getMeetingTitle = () => {
    if (mode === 'chat') return 'Direct Message';
    if (mode === 'audio') return 'Audio Call';
    return 'Video Call';
  };

  const renderDynamicPanel = () => {
    if (mode === 'chat') {
      return (
        <section className="panel chat-panel">
          <div className="messages-list">
            {messages.map((message) => (
              <div key={message.id} className={`message-row ${message.sender}`}>
                <div className="message-bubble">
                  <p>{message.text}</p>
                  <span>{message.time}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="message-input-bar">
            <button className="icon-btn" type="button" aria-label="Open emoji picker">
              🙂
            </button>
            <button className="icon-btn" type="button" aria-label="Attach file">
              📎
            </button>
            <input
              type="text"
              value={messageInput}
              onChange={(event) => setMessageInput(event.target.value)}
              onKeyDown={onMessageKeyDown}
              placeholder="Type a message"
              aria-label="Message input"
            />
            <button className="send-btn" type="button" onClick={sendMessage}>
              Send
            </button>
          </div>
        </section>
      );
    }

    if (mode === 'audio') {
      return (
        <section className="panel audio-panel">
          <div className="audio-avatar">P</div>
          <h2>Priya</h2>
          <p>{status || 'Calling...'}</p>

          <div className="audio-controls">
            <button type="button">Mute</button>
            <button type="button">Speaker</button>
            <button className="danger" type="button">
              End Call
            </button>
          </div>

          <div className="call-actions-inline">
            <button type="button" onClick={startWebcam}>
              Start Media
            </button>
            <button type="button" onClick={createCall}>
              Create Call
            </button>
            <input
              value={callId}
              onChange={(event) => setCallId(event.target.value)}
              placeholder="Join with code"
              aria-label="Join call with code"
            />
            <button type="button" onClick={answerCall}>
              Answer
            </button>
          </div>
        </section>
      );
    }

    return (
      <section className="panel video-panel">
        <div className="video-stage two-user-layout">
          <video ref={remoteVideo} autoPlay playsInline className="remote-video" />
          <video ref={webcamVideo} autoPlay playsInline muted className="self-video" />
        </div>

        <div className="video-controls-overlay">
          <button type="button">Mic</button>
          <button type="button">Camera</button>
          <button className="danger" type="button">
            End
          </button>
          <button type="button">Share</button>
        </div>

        <div className="call-actions-inline">
          <button type="button" onClick={startWebcam}>
            Start Webcam
          </button>
          <button type="button" onClick={createCall}>
            Create Call
          </button>
          <input
            value={callId}
            onChange={(event) => setCallId(event.target.value)}
            placeholder="Join with code"
            aria-label="Join call with code"
          />
          <button type="button" onClick={answerCall}>
            Answer
          </button>
        </div>
      </section>
    );
  };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-left">
          <div className="app-logo">Q</div>
          <span>QChat</span>
        </div>

        <div className="top-center">{getMeetingTitle()}</div>

        <div className="top-right">
          <span className="connection-status">● Connected</span>
          <button className="profile-btn" type="button" aria-label="Profile settings">
            U
          </button>
        </div>
      </header>

      <main className="main-layout">
        <aside className="left-sidebar">
          <div className="search-box">
            <input type="text" placeholder="Search chats" aria-label="Search chats" />
          </div>

          <div className="mode-switch">
            <button type="button" className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}>
              Chat
            </button>
            <button type="button" className={mode === 'audio' ? 'active' : ''} onClick={() => setMode('audio')}>
              Audio
            </button>
            <button type="button" className={mode === 'video' ? 'active' : ''} onClick={() => setMode('video')}>
              Video
            </button>
          </div>

          <div className="contacts-list">
            {contacts.map((contact) => (
              <button key={contact.id} type="button" className={`contact-item ${contact.active ? 'active' : ''}`}>
                <div className="avatar">{contact.name[0]}</div>
                <div className="contact-text">
                  <strong>{contact.name}</strong>
                  <span>{contact.preview}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="right-panel">
          {renderDynamicPanel()}
          {status && <p className="status-line">{status}</p>}
        </section>
      </main>
    </div>
  );
}

export default App;
