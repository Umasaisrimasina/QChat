# QChat Complete Codebase Breakdown

This document explains **every code part** in the workspace:
- What feature it provides
- How it is implemented
- Attributes/state/functions used and their roles
- Where data is stored
- How secure the current method is
- Better alternatives

---

## 1) System Overview

## 1.1 High-level architecture

QChat is split into 3 runtime layers:

1. **Frontend (React + Vite)** in `QChat-app/`
   - UI for chat/audio/video call controls
   - Identity generation and persistence
   - WebRTC call signaling via Firebase Firestore and a custom HTTP signaling server

2. **Signaling backend (Node HTTP server)** in `server/`
   - Registers users
   - Finds/searches users
   - Queues and delivers call invites
   - Stores profile metadata on disk

3. **Realtime call exchange (Firebase Firestore + browser WebRTC)**
   - Offer/answer and ICE candidates are exchanged via Firestore
   - Media stream travels peer-to-peer via WebRTC once connected

---

## 1.2 Main data stores used

- **Browser localStorage**
  - Key: `qchat.identity.v1`
  - Stores identity `{ internalId, publicId, username }`

- **Browser sessionStorage**
  - Key: `qchat.socket.v1`
  - Stores per-tab/session socket-like ID for signaling server mapping

- **Firestore collections**
  - `calls/{callId}`: call metadata, offer/answer, status
  - `calls/{callId}/offerCandidates`
  - `calls/{callId}/answerCandidates`
  - `calls/{callId}/joinRequests`

- **Server memory (volatile)**
  - Maps for online users and pending call requests

- **Server file persistence**
  - `server/data/signaling-store.json` stores registered profile snapshots (not active session maps)

---

## 2) Frontend App Layer

## 2.1 `QChat-app/src/main.jsx`

**Feature**
- React application bootstrap.

**Implementation**
- Uses `createRoot(...).render(...)` with `<StrictMode><App /></StrictMode>`.

**Attributes and functions used**
- `createRoot` (ReactDOM): mounts React app.
- `StrictMode` (React): dev-time checks for unsafe patterns.

**Where data is stored**
- None directly.

**Security level**
- Neutral; no direct security logic.

**Better method**
- Current is standard.

---

## 2.2 `QChat-app/src/App.jsx`

**Feature**
- Main UI and orchestration layer for:
  - Chat UI
  - Audio/video call UX
  - Identity registration
  - User lookup + invite flows
  - Incoming invite prompts

**Implementation**
- React state + effects drive lifecycle.
- Delegates media/call mechanics to `useWebRTC`.
- Delegates identity functions to `identityService`.
- Delegates backend API calls to `signalingService`.

### State/attributes in this file

- `mode`: `'chat' | 'audio' | 'video'`
- `messageInput`, `messages`: local mock chat thread
- `setupDialog`, `setupMicEnabled`, `setupCameraEnabled`: pre-call setup modal
- `identity`, `identityState`, `identityError`: profile and registration status
- `lookupInput`, `lookupResult`, `lookupState`, `lookupError`: user search + invite status
- `incomingInvite`: pending call invitation from server queue
- `socketIdRef`: session signaling identity
- `seenInviteIdsRef`: deduplicates invite popups
- `contacts`: static sidebar contact list (memoized)

### Hook values consumed from `useWebRTC`

- State: `callState`, `status`, `error`, `callId`, `isMicEnabled`, `isCameraEnabled`, `remoteHasVideo`, `pendingJoinRequest`, `isCaller`
- Refs: `localVideoRef`, `remoteVideoRef`
- Actions: `initiateCall`, `answerCallById`, `admitJoinRequest`, `declineJoinRequest`, `endCallForSelf`, `endCallForAll`, `toggleMicrophone`, `toggleCamera`, `setCallId`

### Functions in `App.jsx` and purpose

- `sendMessage()`: append outgoing chat bubble.
- `onMessageKeyDown(e)`: Enter key send shortcut.
- `getMeetingTitle()`: dynamic top-bar title by mode + call state.
- `renderPreJoinControls()`: create/join call controls.
- `onConfirmSetupDialog()`: apply media prefs and create/join call.
- `onFindUser()`: validate and resolve public ID via signaling API.
- `onNotifyUserToJoin()`: send invite request to found user.
- `onAcceptIncomingInvite()`: accept queued invite, set callId, open join dialog.
- `onDeclineIncomingInvite()`: decline queued invite.
- `copyPublicId()`: clipboard copy helper.
- `renderDynamicPanel()`: mode-specific panel rendering (chat/audio/video).

### Side effects and lifecycle behavior

- If no identity: create and persist one.
- Register identity to backend; on `409 conflict`, regenerate public ID and retry (up to 5 attempts).
- Poll pending invites every 3 seconds while connected.
- On `beforeunload`: notify backend disconnect.

**Where data is stored**
- Local UI state in React memory.
- Identity persisted in `localStorage`.
- Session socket ID persisted in `sessionStorage`.
- Incoming invites fetched from backend queue.

**Security level**
- **Medium-low** overall:
  - No authentication/session signing for API actions.
  - UI trusts `socketId` from browser session storage.
  - Client-side polling is simple but spoofable without server auth context.
  - Clipboard use is okay but may expose ID if user device is compromised.

**Better method**
- Add authenticated sessions (JWT/cookie) and bind socket/user server-side.
- Replace polling with WebSocket/SSE for invite delivery.
- Use server-generated, signed invite tokens for join actions.
- Keep identity issuance server-side, not purely client-generated.

---

## 2.3 `QChat-app/src/firebase.js`

**Feature**
- Firebase initialization and Firestore export.

**Implementation**
- Reads `VITE_*` env variables.
- Initializes Firebase app, analytics, Firestore.

**Attributes/functions used**
- `initializeApp(firebaseConfig)`
- `getAnalytics(app)`
- `getFirestore(app)`

**Where data is stored**
- Firestore remote DB.

**Security level**
- Depends on Firestore Security Rules (not present in repo).
- Frontend config keys are public by design, but rules must enforce access.

**Better method**
- Ensure strict Firestore rules (per-call authorization, write constraints, TTL).
- Disable analytics where not needed in sensitive/test contexts.

---

## 2.4 `QChat-app/src/hooks/useWebRTC.js`

**Feature**
- Complete call engine:
  - Local media setup
  - RTCPeerConnection setup
  - Offer/answer exchange through Firestore
  - ICE candidate sync
  - Join request approval flow
  - Call termination and media toggle controls

**Implementation**
- Manages all call state with refs and React state.
- Uses helper service `createPeerConnection` and `closePeerConnection`.
- Firestore listeners (`onSnapshot`) coordinate call updates and ICE.

### Core state/attributes

- Call state: `callState`, `status`, `error`, `callId`, `isCaller`
- Media state: `isMicEnabled`, `isCameraEnabled`, `remoteHasVideo`
- Access control state: `pendingJoinRequest`
- Refs for runtime objects:
  - `clientIdRef`
  - `peerConnectionRef`
  - `localStreamRef`
  - `remoteStreamRef`
  - `activeCallDocRef`
  - unsubscribe refs for snapshots
  - `candidateTargetCollectionRef`
  - `soundedJoinRequestsRef`

### Key functions and what they do

- `generateClientId()`: unique local client ID.
- `mapMediaError()`: user-readable permission/device errors.
- `playJoinRequestTone()`: local beep notification.

- `cleanupMainSubscriptions()`, `cleanupJoinRequestSubscriptions()`: avoid stale listeners.
- `stopLocalStream()`, `resetRemoteStream()`, `resetConnection()`: media and connection teardown.
- `softEndCall(message)`: central reset and post-end UX.

- `createConnection()`: singleton peer connection with handlers:
  - `onTrack`
  - `onIceCandidate`
  - `onConnectionStateChange`

- `attachLocalTracks(stream)`: adds/replaces track senders.
- `startLocalMedia(...)`: gets media, applies mic/camera preferences, updates status.

- `listenCallDocument(callRef)`: reacts to call status/answer updates.
- `watchCandidates(collectionRef)`: listens and applies incoming ICE candidates.
- `watchJoinRequestsAsHost(callRef)`: host listens for pending join requests.

- `initiateCall({callType, mediaPrefs})`: host creates call offer + Firestore doc.
- `completeAnswerAsGuest(...)`: guest sets remote offer and writes answer.
- `answerCallById(id, mediaPrefs)`: guest requests host approval and joins once admitted.
- `admitJoinRequest()`, `declineJoinRequest()`: host decision updates.
- `endCallForSelf()`, `endCallForAll()`: termination behavior.
- `toggleMicrophone()`, `toggleCamera()`: local track enable/disable.

**Where data is stored**
- Runtime WebRTC objects in memory refs.
- Firestore for signaling state and candidates.
- No direct localStorage writes here.

**Security level**
- **Medium-low** unless Firestore rules are strict:
  - Any client knowing call ID may attempt to read/write depending on rules.
  - `requesterName` and role assumptions are client-controlled (`'Guest'`/`'Host'`).
  - No cryptographic integrity for join approvals beyond DB document state.

**Better method**
- Server-mediated signaling with authenticated channels (WebSocket + auth).
- Firestore rules requiring membership/ownership checks per call.
- Short-lived, signed join tokens generated by host-side trusted backend.
- Use TURN servers for NAT traversal reliability (currently STUN-only).

---

## 2.5 `QChat-app/src/hooks/useCallTimer.js`

**Feature**
- Generic call duration timer hook.

**Implementation**
- `seconds` state incremented every second via interval.
- `formatted` output generated with `useMemo(formatDuration)`.

**Functions**
- `formatDuration(totalSeconds)`: `HH:MM:SS` conversion.
- `start()`: begins interval if not running.
- `stop()`: clears interval.
- `reset()`: resets counter.

**Where data is stored**
- React state only.

**Security level**
- Safe/low risk; no I/O.

**Better method**
- Optional: compute via timestamp delta (more accurate if tab sleeps).

---

## 2.6 `QChat-app/src/services/identityService.js`

**Feature**
- Local identity lifecycle utilities.

**Implementation**
- Generates random IDs and usernames.
- Persists identity in localStorage.
- Persists session socket ID in sessionStorage.

### Constants and attributes

- `STORAGE_KEY = 'qchat.identity.v1'`
- `SESSION_SOCKET_KEY = 'qchat.socket.v1'`

### Functions and purpose

- `randomDigits(length)`: numeric random generator.
- `pickPublicIdLength()`: choose 8 or 10 digits.
- `createPublicId()`: public numeric ID.
- `createInternalId()`: UUID or fallback pseudo-random ID.
- `createIdentity()`: returns `{internalId, publicId, username}`.
- `loadIdentity()`: safe parse + shape check from localStorage.
- `saveIdentity(identity)`: persist identity.
- `getOrCreateSocketId()`: sessionStorage socket-like ID.
- `regeneratePublicId()`: new public ID generator.
- `normalizePublicIdInput(value)`: strips non-digits.
- `validatePublicIdFormat(value)`: validates 8 or 10 digit format.

**Where data is stored**
- Browser localStorage/sessionStorage.

**Security level**
- **Low** for trust-sensitive contexts:
  - localStorage/sessionStorage are user-tamperable.
  - IDs are not cryptographically trusted identity proof.

**Better method**
- Use backend-authenticated users (Firebase Auth or custom auth).
- Keep authoritative user identity server-side.
- Use signed session tokens and rotate IDs as needed.

---

## 2.7 `QChat-app/src/services/signalingService.js`

**Feature**
- HTTP client wrapper for signaling backend.

**Implementation**
- `BASE_URL` from `VITE_SIGNALING_URL` fallback `http://localhost:4000`.
- Central `postJson(path, payload)` handles fetch, JSON checks, errors.

### Functions and purpose

- `postJson(path, payload)`: robust POST helper with error mapping.
- `registerUser(payload)`
- `findUser(publicId)`
- `searchUsers(queryText)`
- `callUser(payload)`
- `getPendingCalls(socketId)`
- `respondToCall(payload)`
- `disconnect(socketId)`

**Where data is stored**
- No persistence; network transport only.

**Security level**
- **Medium-low** currently:
  - Uses plain HTTP by default in dev (`localhost`), no token auth.
  - No request signing or anti-replay/anti-spoof checks.

**Better method**
- HTTPS mandatory in deployed environments.
- Attach auth token/cookie and CSRF strategy where applicable.
- Add request IDs + server-side verification/rate limiting.

---

## 2.8 `QChat-app/src/services/webrtcService.js`

**Feature**
- WebRTC peer connection helper abstraction.

**Implementation**
- Exports `rtcServers` with Google STUN entries.
- Creates and wires `RTCPeerConnection` handlers.
- Safe close helper.

### Functions and attributes

- `rtcServers`: ICE config (`stun1`/`stun2`, pool size 10).
- `createPeerConnection({onTrack,onIceCandidate,onConnectionStateChange})`
- `closePeerConnection(peerConnection)`

**Where data is stored**
- Runtime browser connection objects only.

**Security level**
- **Medium** functionally, but reliability/security constraints:
  - STUN-only can fail in restrictive networks.
  - No TURN relay fallback.

**Better method**
- Add authenticated TURN servers (coturn or managed service).
- Enforce encrypted signaling channel and authenticated peers.

---

## 2.9 `QChat-app/src/App.css`

**Feature**
- Full app styling for desktop/mobile.

**Implementation**
- CSS variables + responsive media queries.
- Styles for: shell, top bar, sidebar, chat panel, audio panel, video panel, controls, overlays/modals.

**Attributes used**
- Theme tokens: `--bg`, `--panel`, `--border`, `--accent`, `--danger`, etc.
- State-related classes: `.active`, `.danger`, `.active-control`, `.self-video-hidden`.

**Where data is stored**
- None.

**Security level**
- Safe; presentation only.

**Better method**
- Current approach is fine. Optional: utility CSS system or CSS Modules for scope isolation.

---

## 2.10 `QChat-app/src/index.css`

**Feature**
- Global base styles (`html/body/#root`, default background/font).

**Security level**
- Safe.

---

## 2.11 `QChat-app/index.html`

**Feature**
- Vite HTML entry point.
- Mount root `<div id="root"></div>` and module script `/src/main.jsx`.

**Security level**
- Basic. Could be improved with CSP headers at hosting layer.

**Better method**
- Configure CSP + integrity strategy in production deployment pipeline.

---

## 3) Backend Signaling Layer

## 3.1 `server/index.js`

**Feature**
- Standalone Node HTTP API for user registration, search, call invites, and disconnect handling.

**Implementation**
- Uses Node built-ins (`http`, `fs`, `path`, `crypto`).
- In-memory maps for online state and pending requests.
- JSON file persistence for registered profile snapshots.

### Constants and config

- `PORT` default `4000`
- `STORE_DIR`, `STORE_FILE`
- Body/field limits:
  - `MAX_BODY_SIZE_BYTES` default `16KB`
  - `MAX_ID_LENGTH = 128`
  - `MAX_USERNAME_LENGTH = 64`
  - `MAX_CALL_CODE_LENGTH = 128`
- `ALLOWED_ORIGINS` env parsed list

### In-memory maps

- `usersByPublicId`
- `usersBySocketId`
- `pendingCallsBySocketId`
- `registeredProfilesByPublicId`

### Security/helper functions

- `normalizeOrigin(origin)`
- `resolveCorsOrigin(requestOrigin)`
- `setSecurityHeaders(response)`:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer`
- `parseBody(request)` with max body enforcement
- `sanitizeIdentity(...)`
- `isValidPublicId(publicId)`
- `sanitizeCallCode(callCode)`

### Persistence functions

- `ensureStoreDir()`
- `saveStore()` writes `registeredProfilesByPublicId` users to JSON
- `loadStore()` restores stored profiles

### Core endpoint logic functions

- `registerUser(payload)`
  - validates identity fields + public ID format
  - handles conflict checks by publicId and socket mapping
  - records user online in maps
  - persists profile snapshot

- `findUser({ publicId })`
  - validates ID and returns online user summary

- `searchUsers({ queryText })`
  - case-insensitive search among online users, capped at 20

- `queueCallRequest({ fromSocketId, toPublicId, callCode, callType })`
  - validates sender/target
  - creates request payload with UUID
  - stores in target user queue

- `getPendingCalls({ socketId })`
  - returns queued requests for that socket

- `respondCallRequest({ socketId, requestId, decision })`
  - removes request from pending queue and reports decision

- `disconnectUser({ socketId })`
  - removes online mapping, marks persisted profile last seen, clears pending queue

### Routes exposed

- `GET /health`
- `POST /register-user`
- `POST /find-user`
- `POST /search-users`
- `POST /call-user`
- `POST /pending-calls`
- `POST /respond-call`
- `POST /disconnect`

**Where data is stored**
- Process memory maps (runtime online state).
- Disk file `server/data/signaling-store.json` for profile snapshots.

**Security level**
- **Medium-low**:
  - No authentication/authorization model (socketId is client-supplied).
  - No TLS termination here (depends on deployment proxy).
  - No rate limiter.
  - CORS can be open wildcard if `ALLOWED_ORIGINS` empty.
  - Basic input sanitization and body limits are good.

**Better method**
- Move to Express/Fastify + middleware stack:
  - Auth (JWT/session)
  - Rate limiting
  - Schema validation (e.g., Zod/Joi)
  - Structured logging + request IDs
- Persist active state in Redis instead of process memory.
- Use WebSocket for real-time invites and disconnect awareness.
- Use HTTPS and reverse proxy hardening.

---

## 3.2 `server/data/signaling-store.json`

**Feature**
- Persistent cache of registered profile history.

**Current structure**
- `users[]` with fields:
  - `internalId`
  - `publicId`
  - `username`
  - `updatedAt`
  - `lastSeenAt`

**Security level**
- **Low** if file ACLs are weak (plaintext local file).

**Data consistency observation**
- File currently contains a `publicId` format (`OAK1-RHU8`) that does **not** match current server validation (`8/10 digits only`). This indicates legacy/test data drift.

**Better method**
- Use a real DB with schema constraints + migrations (PostgreSQL/SQLite/Firestore).
- Encrypt sensitive user fields at rest if required by policy.
- Add migration/cleanup process for invalid legacy records.

---

## 4) Build/Tooling/Config Files

## 4.1 `QChat-app/package.json`

**Feature**
- Frontend dependencies and scripts.

**Scripts**
- `dev`, `build`, `lint`, `preview`

**Key deps**
- React, Firebase, Vite, ESLint and plugins.

**Security level**
- Standard. Keep deps patched and pin lockfile in CI.

---

## 4.2 `QChat-app/vite.config.js`

**Feature**
- Vite config with React plugin.

**Security level**
- Neutral.

---

## 4.3 `QChat-app/eslint.config.js`

**Feature**
- Lint setup for JS/JSX with React Hooks and react-refresh rules.

**Security relevance**
- Improves code quality but not runtime security directly.

---

## 4.4 Root `package.json`

**Feature**
- Separate dependency declaration (`firebase`) at repository root.

**Observation**
- Project appears to manage frontend deps under `QChat-app/package.json`; root dependency setup may be redundant or for shared tooling.

---

## 4.5 `QChat-app/README.md`

**Feature**
- Default Vite template README (not project-specific).

**Better method**
- Replace with project-specific setup, env vars, architecture, and security notes.

---

## 5) Asset Files

- `QChat-app/src/assets/hero.png`
- `QChat-app/src/assets/react.svg`
- `QChat-app/src/assets/vite.svg`

**Feature**
- Static assets only.

**Security level**
- Low risk; ensure trusted source and no user-upload overwrite path.

---

## 6) End-to-End Feature Mapping

## 6.1 Identity lifecycle

1. `App.jsx` loads local identity (`loadIdentity`)
2. If absent: creates identity (`createIdentity`) and saves (`saveIdentity`)
3. Registers to backend (`signalingService.registerUser`)
4. Backend validates and tracks online state (`registerUser` in server)

## 6.2 User discovery and invite

1. Enter public ID in UI
2. Client validates format (`validatePublicIdFormat`)
3. Client calls `/find-user`
4. Client sends `/call-user` with call code and type
5. Receiver polls `/pending-calls` and accepts/declines via `/respond-call`

## 6.3 WebRTC call establishment

1. Host creates Firestore call doc with offer
2. Guest requests host approval (joinRequests subcollection)
3. Host admits request
4. Guest writes answer
5. Both sides exchange ICE candidates via Firestore subcollections
6. Peer connection becomes connected; media flows directly P2P

---

## 7) Security Assessment Summary

## 7.1 What is already good

- Input size limits and truncation on backend
- Basic JSON parsing guardrails and error responses
- Some defensive headers (`nosniff`, `DENY`, `no-referrer`)
- CORS allowlist option via env
- Local media permission errors are mapped and handled

## 7.2 Main security risks

1. **No authentication/authorization** across signaling endpoints
2. **Client-trust issue** (`socketId`, identity fields can be forged)
3. **Potential open CORS** when allowlist is not configured
4. **Polling design** can be abused or inefficient
5. **Firestore access control unknown** (rules not present)
6. **No TURN configuration** may break connectivity and reliability

## 7.3 Recommended stronger architecture

- Add **Auth** (Firebase Auth or custom JWT) before any signaling action
- Bind user identity to authenticated session on backend
- Replace polling with authenticated WebSocket channels
- Add rate limiting and request schema validation middleware
- Enforce strict Firestore rules by call membership and operation type
- Add TURN servers for reliable WebRTC in restrictive NAT/firewall setups
- Store persistent data in DB (with migrations), not ad hoc JSON file

---

## 8) Important Consistency Notes

1. `server/data/signaling-store.json` currently has a `publicId` value that does not match current numeric validation rules.
2. `QChat-app/src/hooks/useCallTimer.js` is present but appears unused by current UI logic.
3. `QChat-app/src/assets/*` files appear unused by `App.jsx` currently.

---

## 9) Overall Codebase Maturity Snapshot

- **UX/Prototype maturity**: Good for demoing core call/chat flows
- **Architecture maturity**: Moderate (clean separation between UI/services/hooks/backend)
- **Production security maturity**: Low-to-moderate (needs auth, stricter access control, hardened signaling)

If your target is production, prioritize authentication + Firestore rules + signaling hardening first.