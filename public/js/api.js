const API = {
  async getOptions() {
    const res = await fetch('/api/options');
    return res.json();
  },

  async getAccount() {
    const res = await fetch('/api/account');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data.data;
  },

  async listInstances() {
    const res = await fetch('/api/instances');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data.data;
  },

  async createInstances(params) {
    const res = await fetch('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return { taskId: data.taskId, totalSteps: data.totalSteps };
  },

  subscribeProgress(taskId, { onProgress, onComplete, onError }) {
    const es = new EventSource(`/api/tasks/${taskId}/progress`);

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
    const res = await fetch(`/api/instances/${id}/start`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data;
  },

  async stopInstance(id) {
    const res = await fetch(`/api/instances/${id}/stop`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data;
  },

  async rebootInstance(id) {
    const res = await fetch(`/api/instances/${id}/reboot`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data;
  },

  async deleteInstance(id) {
    const res = await fetch(`/api/instances/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data;
  },

  async deleteInstances(ids) {
    const res = await fetch('/api/instances', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, confirm: true }),
    });
    const data = await res.json();
    return data;
  },

  getRdpUrl(id, username) {
    return `/api/instances/${id}/rdp?username=${encodeURIComponent(username || 'Administrator')}`;
  },
};
