// ─── Token Management ───
function getToken() { return localStorage.getItem('auth_token'); }
function setToken(t) { localStorage.setItem('auth_token', t); }
function clearToken() { localStorage.removeItem('auth_token'); }

async function authFetch(url, opts = {}) {
  const token = getToken();
  if (!opts.headers) opts.headers = {};
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (!opts.headers['Content-Type'] && opts.body) opts.headers['Content-Type'] = 'application/json';
  const res = await fetch(url, opts);
  if (res.status === 401) {
    clearToken();
    if (typeof window.app !== 'undefined' && window.app.showLogin) {
      window.app.showLogin();
    }
    throw new Error('Sessao expirada. Faca login novamente.');
  }
  return res;
}

const API = {
  // ─── Auth ───
  async register(email, password) {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data.user;
  },

  async login(email, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    setToken(data.token);
    return data.user;
  },

  logout() {
    clearToken();
    if (window.app && window.app.showLogin) window.app.showLogin();
  },

  async getMe() {
    const res = await authFetch('/api/auth/me');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data.user;
  },

  // ─── Options ───
  async getOptions() {
    const res = await authFetch('/api/options');
    return res.json();
  },

  async getAccount() {
    const res = await authFetch('/api/account');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data.data;
  },

  // ─── Instances ───
  async listInstances() {
    const res = await authFetch('/api/instances');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data.data;
  },

  async createInstances(params) {
    const res = await authFetch('/api/instances', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return { taskId: data.taskId, totalSteps: data.totalSteps };
  },

  subscribeProgress(taskId, { onProgress, onComplete, onError }) {
    const token = getToken();
    const es = new EventSource(`/api/tasks/${taskId}/progress?token=${encodeURIComponent(token)}`);

    es.addEventListener('progress', (e) => {
      onProgress(JSON.parse(e.data));
    });

    es.addEventListener('complete', (e) => {
      onComplete(JSON.parse(e.data));
      es.close();
    });

    es.addEventListener('error', (e) => {
      if (e.data) {
        onError(JSON.parse(e.data));
      } else {
        onError({ message: 'Conexao perdida com o servidor' });
      }
      es.close();
    });

    es.addEventListener('keepalive', () => {});
    return es;
  },

  async startInstance(id) {
    const res = await authFetch(`/api/instances/${id}/start`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data;
  },

  async stopInstance(id) {
    const res = await authFetch(`/api/instances/${id}/stop`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data;
  },

  async rebootInstance(id) {
    const res = await authFetch(`/api/instances/${id}/reboot`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data;
  },

  async deleteInstance(id) {
    const res = await authFetch(`/api/instances/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: true }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data;
  },

  async deleteInstances(ids) {
    const res = await authFetch('/api/instances', {
      method: 'DELETE',
      body: JSON.stringify({ ids, confirm: true }),
    });
    const data = await res.json();
    return data;
  },

  async claimUnowned() {
    const res = await authFetch('/api/admin/claim-unowned', { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data;
  },

  getRdpUrl(id, username) {
    const token = getToken();
    return `/api/instances/${id}/rdp?username=${encodeURIComponent(username || 'Administrator')}&token=${encodeURIComponent(token)}`;
  },
};
