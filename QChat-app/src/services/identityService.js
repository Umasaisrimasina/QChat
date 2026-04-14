const STORAGE_KEY = 'qchat.identity.v1';
const SESSION_SOCKET_KEY = 'qchat.socket.v1';

const randomDigits = (length) => {
  let value = '';
  while (value.length < length) {
    value += Math.floor(Math.random() * 10).toString();
  }
  return value.slice(0, length);
};

const pickPublicIdLength = () => (Math.random() < 0.5 ? 8 : 10);

export const createPublicId = () => randomDigits(pickPublicIdLength());

export const createInternalId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export const createIdentity = () => {
  const internalId = createInternalId();
  const publicId = createPublicId();

  return {
    internalId,
    publicId,
    username: `User-${publicId.slice(-4)}`,
  };
};

export const loadIdentity = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed?.internalId || !parsed?.publicId || !parsed?.username) {
      return null;
    }

    return {
      internalId: parsed.internalId,
      publicId: String(parsed.publicId),
      username: parsed.username,
    };
  } catch {
    return null;
  }
};

export const saveIdentity = (identity) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
};

export const getOrCreateSocketId = () => {
  const existing = sessionStorage.getItem(SESSION_SOCKET_KEY);
  if (existing) {
    return existing;
  }

  const socketId = createInternalId();
  sessionStorage.setItem(SESSION_SOCKET_KEY, socketId);
  return socketId;
};

export const regeneratePublicId = () => createPublicId();

export const normalizePublicIdInput = (value) => String(value || '').replace(/\D/g, '').trim();

export const validatePublicIdFormat = (value) => /^\d{8}(\d{2})?$/.test(normalizePublicIdInput(value));
