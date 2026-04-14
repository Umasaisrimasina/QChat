const BASE_URL = import.meta.env.VITE_SIGNALING_URL || 'http://localhost:4000';

const postJson = async (path, payload) => {
  let response;

  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error('Signaling server is unreachable. Start backend on port 4000.');
  }

  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();

  if (!contentType.includes('application/json')) {
    throw new Error('Signaling server returned non-JSON response. Check VITE_SIGNALING_URL/backend route.');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON from signaling server.');
  }

  if (!response.ok) {
    throw new Error(parsed?.error || 'Signaling server request failed.');
  }

  return parsed.data;
};

export const signalingService = {
  async registerUser(payload) {
    return postJson('/register-user', payload);
  },

  async findUser(publicId) {
    return postJson('/find-user', { publicId });
  },

  async searchUsers(queryText) {
    return postJson('/search-users', { queryText });
  },

  async callUser(payload) {
    return postJson('/call-user', payload);
  },

  async getPendingCalls(socketId) {
    return postJson('/pending-calls', { socketId });
  },

  async respondToCall(payload) {
    return postJson('/respond-call', payload);
  },

  async disconnect(socketId) {
    return postJson('/disconnect', { socketId });
  },
};
