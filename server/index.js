const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 4000;
const STORE_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(STORE_DIR, 'signaling-store.json');
const MAX_BODY_SIZE_BYTES = Number(process.env.MAX_BODY_SIZE_BYTES || 16 * 1024);
const MAX_ID_LENGTH = 128;
const MAX_USERNAME_LENGTH = 64;
const MAX_CALL_CODE_LENGTH = 128;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const usersByPublicId = new Map();
const usersBySocketId = new Map();
const pendingCallsBySocketId = new Map();
const registeredProfilesByPublicId = new Map();

const normalizeOrigin = (origin) => String(origin || '').trim();

const resolveCorsOrigin = (requestOrigin) => {
  const normalizedOrigin = normalizeOrigin(requestOrigin);
  if (!allowedOrigins.length) {
    return '*';
  }

  if (allowedOrigins.includes(normalizedOrigin)) {
    return normalizedOrigin;
  }

  return '';
};

const setSecurityHeaders = (response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
};

const ensureStoreDir = () => {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
};

const saveStore = () => {
  ensureStoreDir();

  const payload = {
    users: [...registeredProfilesByPublicId.values()],
  };

  fs.writeFileSync(STORE_FILE, JSON.stringify(payload, null, 2), 'utf8');
};

const loadStore = () => {
  try {
    if (!fs.existsSync(STORE_FILE)) {
      return;
    }

    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    if (!raw.trim()) {
      return;
    }

    const parsed = JSON.parse(raw);
    const savedUsers = Array.isArray(parsed?.users) ? parsed.users : [];

    savedUsers.forEach((savedUser) => {
      const identity = sanitizeIdentity({
        internalId: savedUser?.internalId,
        publicId: savedUser?.publicId,
        username: savedUser?.username,
      });

      if (!identity.internalId || !identity.publicId || !identity.username) {
        return;
      }

      registeredProfilesByPublicId.set(identity.publicId, {
        internalId: identity.internalId,
        publicId: identity.publicId,
        username: identity.username,
        updatedAt: Number(savedUser?.updatedAt) || Date.now(),
        lastSeenAt: Number(savedUser?.lastSeenAt) || Date.now(),
      });
    });
  } catch (error) {
    console.error('Failed to load signaling store:', error.message);
  }
};

const writeJson = (request, response, statusCode, payload) => {
  const corsOrigin = resolveCorsOrigin(request.headers.origin);

  if (corsOrigin) {
    response.setHeader('Access-Control-Allow-Origin', corsOrigin);
  }

  setSecurityHeaders(response);

  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  response.end(JSON.stringify(payload));
};

const parseBody = (request) =>
  new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    let tooLarge = false;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE_BYTES) {
        tooLarge = true;
        return;
      }

      raw += chunk;
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(new Error('Request body too large.'));
        return;
      }

      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    request.on('error', reject);
  });

const sanitizeIdentity = ({ internalId, publicId, username, socketId }) => ({
  internalId: String(internalId || '')
    .trim()
    .slice(0, MAX_ID_LENGTH),
  publicId: String(publicId || '')
    .trim()
    .toUpperCase()
    .slice(0, 10),
  username: String(username || '')
    .trim()
    .slice(0, MAX_USERNAME_LENGTH),
  socketId: String(socketId || '')
    .trim()
    .slice(0, MAX_ID_LENGTH),
});

const isValidPublicId = (publicId) => /^\d{8}(\d{2})?$/.test(String(publicId || '').trim());

const sanitizeCallCode = (callCode) =>
  String(callCode || '')
    .trim()
    .slice(0, MAX_CALL_CODE_LENGTH);

const registerUser = (payload) => {
  const identity = sanitizeIdentity(payload);

  if (!identity.internalId || !identity.publicId || !identity.username || !identity.socketId) {
    return { ok: false, statusCode: 400, error: 'Missing required registration fields.' };
  }

  if (!isValidPublicId(identity.publicId)) {
    return { ok: false, statusCode: 400, error: 'Invalid public ID format.' };
  }

  const existingProfile = registeredProfilesByPublicId.get(identity.publicId);
  if (existingProfile && existingProfile.internalId !== identity.internalId) {
    return { ok: false, statusCode: 409, error: 'Public ID conflict.' };
  }

  const existingByPublicId = usersByPublicId.get(identity.publicId);
  if (existingByPublicId && existingByPublicId.internalId !== identity.internalId) {
    return { ok: false, statusCode: 409, error: 'Public ID conflict.' };
  }

  const existingBySocket = usersBySocketId.get(identity.socketId);
  if (existingBySocket && existingBySocket.publicId !== identity.publicId) {
    usersByPublicId.delete(existingBySocket.publicId);
  }

  const user = {
    ...identity,
    status: 'online',
    updatedAt: Date.now(),
  };

  registeredProfilesByPublicId.set(identity.publicId, {
    internalId: identity.internalId,
    publicId: identity.publicId,
    username: identity.username,
    updatedAt: Date.now(),
    lastSeenAt: Date.now(),
  });

  usersByPublicId.set(identity.publicId, user);
  usersBySocketId.set(identity.socketId, user);
  saveStore();

  return { ok: true, statusCode: 200, data: user };
};

const findUser = ({ publicId }) => {
  const lookup = String(publicId || '').trim().toUpperCase();
  if (!lookup) {
    return { ok: false, statusCode: 400, error: 'publicId is required.' };
  }

  if (!isValidPublicId(lookup)) {
    return { ok: false, statusCode: 400, error: 'Invalid public ID format.' };
  }

  const user = usersByPublicId.get(lookup);
  if (!user || user.status !== 'online') {
    return { ok: false, statusCode: 404, error: 'User not found or offline.' };
  }

  return {
    ok: true,
    statusCode: 200,
    data: {
      publicId: user.publicId,
      username: user.username,
      socketId: user.socketId,
      status: user.status,
    },
  };
};

const searchUsers = ({ queryText }) => {
  const text = String(queryText || '')
    .trim()
    .toLowerCase()
    .slice(0, MAX_USERNAME_LENGTH);
  if (!text) {
    return { ok: true, statusCode: 200, data: [] };
  }

  const results = [...usersByPublicId.values()]
    .filter((user) => user.status === 'online')
    .filter((user) => user.username.toLowerCase().includes(text) || user.publicId.toLowerCase().includes(text))
    .slice(0, 20)
    .map((user) => ({
      publicId: user.publicId,
      username: user.username,
      socketId: user.socketId,
      status: user.status,
    }));

  return { ok: true, statusCode: 200, data: results };
};

const queueCallRequest = ({ fromSocketId, toPublicId, callCode, callType }) => {
  const normalizedFromSocketId = String(fromSocketId || '')
    .trim()
    .slice(0, MAX_ID_LENGTH);
  const normalizedToPublicId = String(toPublicId || '')
    .trim()
    .toUpperCase()
    .slice(0, 10);
  const normalizedCallCode = sanitizeCallCode(callCode);

  if (!isValidPublicId(normalizedToPublicId)) {
    return { ok: false, statusCode: 400, error: 'Invalid target public ID.' };
  }

  if (!normalizedCallCode) {
    return { ok: false, statusCode: 400, error: 'Call code is required.' };
  }

  const fromUser = usersBySocketId.get(normalizedFromSocketId);
  const toUser = usersByPublicId.get(normalizedToPublicId);

  if (!fromUser) {
    return { ok: false, statusCode: 401, error: 'Sender is not registered.' };
  }

  if (!toUser || toUser.status !== 'online') {
    return { ok: false, statusCode: 404, error: 'Target user is offline or not found.' };
  }

  const requestPayload = {
    requestId: randomUUID(),
    fromSocketId: fromUser.socketId,
    fromPublicId: fromUser.publicId,
    fromUsername: fromUser.username,
    toSocketId: toUser.socketId,
    toPublicId: toUser.publicId,
    toUsername: toUser.username,
    callCode: normalizedCallCode,
    callType: callType === 'audio' ? 'audio' : 'video',
    createdAt: Date.now(),
    status: 'pending',
  };

  const pending = pendingCallsBySocketId.get(toUser.socketId) || [];
  pending.push(requestPayload);
  pendingCallsBySocketId.set(toUser.socketId, pending);

  return { ok: true, statusCode: 200, data: requestPayload };
};

const getPendingCalls = ({ socketId }) => {
  const key = String(socketId || '')
    .trim()
    .slice(0, MAX_ID_LENGTH);
  if (!key) {
    return { ok: false, statusCode: 400, error: 'socketId is required.' };
  }

  const pending = pendingCallsBySocketId.get(key) || [];
  return { ok: true, statusCode: 200, data: pending };
};

const respondCallRequest = ({ socketId, requestId, decision }) => {
  const key = String(socketId || '')
    .trim()
    .slice(0, MAX_ID_LENGTH);
  const reqId = String(requestId || '')
    .trim()
    .slice(0, MAX_ID_LENGTH);

  if (!key || !reqId) {
    return { ok: false, statusCode: 400, error: 'socketId and requestId are required.' };
  }

  const pending = pendingCallsBySocketId.get(key) || [];
  const nextPending = pending.filter((request) => request.requestId !== reqId);
  pendingCallsBySocketId.set(key, nextPending);

  return {
    ok: true,
    statusCode: 200,
    data: {
      requestId: reqId,
      decision: decision === 'decline' ? 'decline' : 'accept',
    },
  };
};

const disconnectUser = ({ socketId }) => {
  const key = String(socketId || '')
    .trim()
    .slice(0, MAX_ID_LENGTH);
  if (!key) {
    return { ok: false, statusCode: 400, error: 'socketId is required.' };
  }

  const user = usersBySocketId.get(key);
  if (user) {
    usersByPublicId.delete(user.publicId);

    const profile = registeredProfilesByPublicId.get(user.publicId);
    if (profile) {
      registeredProfilesByPublicId.set(user.publicId, {
        ...profile,
        lastSeenAt: Date.now(),
      });
      saveStore();
    }
  }

  usersBySocketId.delete(key);
  pendingCallsBySocketId.delete(key);

  return { ok: true, statusCode: 200, data: { disconnected: true } };
};

loadStore();

const server = http.createServer(async (request, response) => {
  const { method } = request;
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const routePath = requestUrl.pathname;

  if (allowedOrigins.length && !resolveCorsOrigin(request.headers.origin)) {
    writeJson(request, response, 403, { error: 'Origin not allowed.' });
    return;
  }

  if (method === 'OPTIONS') {
    writeJson(request, response, 204, {});
    return;
  }

  if (method === 'GET' && routePath === '/health') {
    writeJson(request, response, 200, { status: 'ok', service: 'qchat-signaling' });
    return;
  }

  if (method !== 'POST') {
    writeJson(request, response, 404, { error: 'Not found' });
    return;
  }

  let body = {};
  try {
    body = await parseBody(request);
  } catch (error) {
    writeJson(request, response, 400, { error: error.message });
    return;
  }

  let result;
  if (routePath === '/register-user') {
    result = registerUser(body);
  } else if (routePath === '/find-user') {
    result = findUser(body);
  } else if (routePath === '/search-users') {
    result = searchUsers(body);
  } else if (routePath === '/call-user') {
    result = queueCallRequest(body);
  } else if (routePath === '/pending-calls') {
    result = getPendingCalls(body);
  } else if (routePath === '/respond-call') {
    result = respondCallRequest(body);
  } else if (routePath === '/disconnect') {
    result = disconnectUser(body);
  } else {
    writeJson(request, response, 404, { error: 'Not found' });
    return;
  }

  if (!result.ok) {
    writeJson(request, response, result.statusCode, { error: result.error });
    return;
  }

  writeJson(request, response, result.statusCode, { data: result.data });
});

server.listen(PORT, () => {
  console.log(`QChat signaling server listening on http://localhost:${PORT}`);
});
