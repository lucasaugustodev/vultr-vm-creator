require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const vultr = require('./vultr-service');
const { provision } = require('./provisioner');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Tunnel URL detection ───
let tunnelUrl = null;
const TUNNEL_LOG = path.join(__dirname, 'cloudflare-tunnel.log');

function detectTunnelUrl() {
  try {
    const log = fs.readFileSync(TUNNEL_LOG, 'utf8');
    const matches = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    if (matches) tunnelUrl = matches[matches.length - 1];
  } catch (_) {}
  // Also check the Azure project tunnel log as fallback
  try {
    if (!tunnelUrl) {
      const azureLog = fs.readFileSync(path.normalize('C:/Users/rootlucas/azure-vm-creator/cloudflare-tunnel.log'), 'utf8');
      const matches = azureLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
      if (matches) tunnelUrl = matches[matches.length - 1];
    }
  } catch (_) {}
  return tunnelUrl;
}
detectTunnelUrl();
setInterval(detectTunnelUrl, 30000);

function ensureTunnel() {
  if (tunnelUrl) return;
  try {
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
      detached: true,
      stdio: ['ignore', fs.openSync(TUNNEL_LOG, 'a'), fs.openSync(TUNNEL_LOG, 'a')],
    });
    proc.unref();
    console.log('Cloudflare tunnel started (PID:', proc.pid, ')');
    // Give it a few seconds then re-detect
    setTimeout(detectTunnelUrl, 5000);
    setTimeout(detectTunnelUrl, 10000);
  } catch (err) {
    console.error('Failed to start cloudflare tunnel:', err.message);
  }
}

// ─── In-memory task tracker (SSE) ───
const tasks = new Map();

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, data] of tasks) {
    if (data.startedAt < cutoff) tasks.delete(id);
  }
}, 5 * 60 * 1000);

function createTask(id) {
  const task = {
    startedAt: Date.now(),
    status: 'running',
    steps: [],
    result: null,
    error: null,
    listeners: [],
  };
  tasks.set(id, task);
  return task;
}

function emitToTask(taskId, event, data) {
  const task = tasks.get(taskId);
  if (!task) return;
  if (event === 'progress') task.steps.push(data);
  for (const send of task.listeners) {
    send(event, data);
  }
}

// ─── Cached OS list for detection ───
let cachedOSForDetection = null;

// ─── Claude Launcher Web project dir ───
const LAUNCHER_WEB_DIR = path.normalize(path.join(__dirname, '..', 'claude-launcher-web'));

// ─── GET /api/options ───
app.get('/api/options', async (req, res) => {
  try {
    const [osList, regions, plans] = await Promise.all([
      vultr.getOSList(),
      vultr.getRegions(),
      vultr.getPlans(),
    ]);
    cachedOSForDetection = osList;
    res.json({
      plans,
      windowsOS: osList.windows,
      linuxOS: osList.linux,
      regions,
      launcherWebAvailable: true,
      tunnelAvailable: !!tunnelUrl,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/account ───
app.get('/api/account', async (req, res) => {
  try {
    const account = await vultr.getAccountInfo();
    res.json({ success: true, data: account });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/instances ───
app.get('/api/instances', async (req, res) => {
  try {
    const instances = await vultr.listInstances();
    res.json({ success: true, data: instances });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/instances (create single or batch) ───
app.post('/api/instances', async (req, res) => {
  const { label, region, plan, osId, count, installClaude, adminPassword } = req.body;

  if (!label || !region || !plan || !osId) {
    return res.status(400).json({ success: false, error: 'label, region, plan e osId obrigatorios' });
  }

  const qty = Math.min(Math.max(parseInt(count) || 1, 1), 20);
  const isWindows = vultr.isWindowsOS(osId, cachedOSForDetection);
  const taskId = crypto.randomUUID();

  // Steps: create(1) + wait(1) + provision steps
  // Windows provision: connect(1) + rdp(1) + git(1) + node(1) + path(1) + claude(1) + cline(1) + launcherWeb(1) + shortcuts(1) + password(1) = 10
  // Linux provision: connect(1) + git(1) + node(1) + claude(1) + cline(1) + launcherWeb(1) = 6
  const winSteps = 10; // connect + rdp + git + node + path + claude + cline + launcherWeb + shortcuts + password
  const linuxSteps = 6; // connect + git + node + claude + cline + launcherWeb (always)
  const provSteps = isWindows ? (installClaude ? winSteps : 0) : linuxSteps;
  const stepsPerVm = 2 + provSteps;
  const totalSteps = qty * stepsPerVm;
  createTask(taskId);

  (async () => {
    try {
      const results = [];

      for (let i = 0; i < qty; i++) {
        const instanceLabel = qty > 1 ? `${label}-${String(i + 1).padStart(2, '0')}` : label;
        let stepNum = i * stepsPerVm;

        // Step 1: Create instance (with startup script for Windows)
        stepNum++;
        emitToTask(taskId, 'progress', {
          step: stepNum, total: totalSteps,
          label: `Criar ${instanceLabel}`,
          status: 'in_progress',
          detail: `Criando instancia ${i + 1}/${qty}...`,
        });

        // For Windows: create a startup script to enable WinRM remote access
        let scriptId = null;
        if (isWindows) {
          try {
            const script = vultr.buildWindowsRemoteEnableScript();
            const ss = await vultr.createStartupScript(`winrm-${instanceLabel}`, script);
            scriptId = ss.id;
          } catch (ssErr) {
            console.error(`[Script] Failed to create startup script:`, ssErr.message);
          }
        }

        const instance = await vultr.createInstance({
          label: instanceLabel, region, plan,
          osId: parseInt(osId),
          hostname: instanceLabel,
          tag: 'vultr-vm-creator',
          scriptId,
        });

        // IMPORTANT: Save the Vultr-generated password from the creation response
        const vultrPassword = instance.default_password;
        console.log(`[Create] ${instanceLabel}: ID=${instance.id}, password=${vultrPassword ? 'captured' : 'NOT available'}`);

        // Cleanup startup script (no longer needed after instance creation)
        if (scriptId) {
          vultr.deleteStartupScript(scriptId).catch(() => {});
        }

        emitToTask(taskId, 'progress', {
          step: stepNum, total: totalSteps,
          label: `Criar ${instanceLabel}`,
          status: 'done',
          detail: `ID: ${instance.id} | Senha: ${vultrPassword || '...'}`,
        });

        // Step 2: Wait for active
        stepNum++;
        emitToTask(taskId, 'progress', {
          step: stepNum, total: totalSteps,
          label: `Aguardar ${instanceLabel}`,
          status: 'in_progress',
          detail: 'Provisionando...',
        });

        const ready = await vultr.waitForActive(instance.id, (status) => {
          emitToTask(taskId, 'progress', {
            step: stepNum, total: totalSteps,
            label: `Aguardar ${instanceLabel}`,
            status: 'in_progress',
            detail: `${status.status} | ${status.powerStatus} | IP: ${status.ip || '...'}`,
          });
        });

        emitToTask(taskId, 'progress', {
          step: stepNum, total: totalSteps,
          label: `Aguardar ${instanceLabel}`,
          status: 'done',
          detail: `Ativa! IP: ${ready.ip}`,
        });

        // Steps 3+: Remote provisioning (always for Linux, on-demand for Windows)
        if ((installClaude || !isWindows) && ready.ip && ready.ip !== '0.0.0.0') {
          stepNum++;
          const connectPassword = vultrPassword || adminPassword || 'VultrAdmin2026';

          emitToTask(taskId, 'progress', {
            step: stepNum, total: totalSteps,
            label: `Conectar ${instanceLabel}`,
            status: 'in_progress',
            detail: `Conectando via ${isWindows ? 'WinRM' : 'SSH'} em ${ready.ip}...`,
          });

          try {
            await provision({
              host: ready.ip,
              password: connectPassword,
              isWindows,
              adminPassword: adminPassword || connectPassword,
              onStatus: (msg) => {
                emitToTask(taskId, 'progress', {
                  step: stepNum, total: totalSteps,
                  label: `Conectar ${instanceLabel}`,
                  status: 'in_progress',
                  detail: msg,
                });
              },
              onStep: (info) => {
                const overallStep = stepNum + 1 + info.index;
                emitToTask(taskId, 'progress', {
                  step: overallStep, total: totalSteps,
                  label: info.label,
                  status: info.status === 'done' ? 'done' : info.status === 'error' ? 'done' : 'in_progress',
                  detail: info.detail,
                });
              },
            });

            emitToTask(taskId, 'progress', {
              step: stepNum, total: totalSteps,
              label: `Conectar ${instanceLabel}`,
              status: 'done',
              detail: 'Provisionamento concluido!',
            });
          } catch (provErr) {
            console.error(`[Provision] Failed for ${instanceLabel}:`, provErr.message);
            emitToTask(taskId, 'progress', {
              step: stepNum, total: totalSteps,
              label: `Conectar ${instanceLabel}`,
              status: 'done',
              detail: `Falhou: ${provErr.message}`,
            });
          }
        }

        // Store password on result for display
        ready.defaultPassword = vultrPassword || ready.defaultPassword;
        results.push(ready);
      }

      const task = tasks.get(taskId);
      if (!task) return;
      task.status = 'completed';
      task.result = results;
      const elapsed = Math.round((Date.now() - task.startedAt) / 1000);

      for (const send of task.listeners) {
        send('complete', { instances: results, elapsed, installClaude: !!installClaude, isWindows, hasLauncherWeb: true });
      }
    } catch (err) {
      const task = tasks.get(taskId);
      if (!task) return;
      task.status = 'error';
      task.error = err.message;
      for (const send of task.listeners) {
        send('error', { message: err.message });
      }
    }
  })();

  res.status(202).json({ success: true, taskId, totalSteps });
});

// ─── GET /api/tasks/:id/progress (SSE) ───
app.get('/api/tasks/:id/progress', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ success: false, error: 'Task not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  for (const step of task.steps) {
    send('progress', step);
  }

  if (task.status === 'completed') {
    const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
    send('complete', { instances: task.result, elapsed });
    return res.end();
  }
  if (task.status === 'error') {
    send('error', { message: task.error });
    return res.end();
  }

  task.listeners.push(send);

  const keepalive = setInterval(() => {
    const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
    send('keepalive', { elapsed });
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    const idx = task.listeners.indexOf(send);
    if (idx !== -1) task.listeners.splice(idx, 1);
  });
});

// ─── POST /api/instances/:id/start ───
app.post('/api/instances/:id/start', async (req, res) => {
  try {
    await vultr.startInstance(req.params.id);
    res.json({ success: true, message: 'Instancia iniciada' });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/instances/:id/stop ───
app.post('/api/instances/:id/stop', async (req, res) => {
  try {
    await vultr.stopInstance(req.params.id);
    res.json({ success: true, message: 'Instancia parada' });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/instances/:id/reboot ───
app.post('/api/instances/:id/reboot', async (req, res) => {
  try {
    await vultr.rebootInstance(req.params.id);
    res.json({ success: true, message: 'Instancia reiniciada' });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── DELETE /api/instances/:id ───
app.delete('/api/instances/:id', async (req, res) => {
  if (!req.body.confirm) {
    return res.status(400).json({ success: false, error: 'Confirmacao necessaria' });
  }
  try {
    await vultr.deleteInstance(req.params.id);
    res.json({ success: true, message: 'Instancia deletada' });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── DELETE /api/instances (batch delete) ───
app.delete('/api/instances', async (req, res) => {
  const { ids, confirm } = req.body;
  if (!confirm || !ids || !Array.isArray(ids)) {
    return res.status(400).json({ success: false, error: 'ids[] e confirm necessarios' });
  }
  try {
    const results = await Promise.allSettled(
      ids.map(id => vultr.deleteInstance(id))
    );
    const failed = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
    res.json({
      success: failed.length === 0,
      deleted: ids.length - failed.length,
      failed,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/instances/:id/rdp ───
app.get('/api/instances/:id/rdp', async (req, res) => {
  try {
    const instance = await vultr.getInstance(req.params.id);
    if (!instance.ip || instance.ip === '0.0.0.0') {
      return res.status(404).json({ success: false, error: 'IP nao disponivel' });
    }
    const username = req.query.username || 'Administrator';
    const rdpContent = vultr.generateRdpContent(instance.ip, username);
    res.setHeader('Content-Type', 'application/x-rdp');
    res.setHeader('Content-Disposition', `attachment; filename="${instance.label || instance.id}.rdp"`);
    res.send(rdpContent);
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── Serve Claude Launcher Web as zip ───
if (fs.existsSync(path.join(LAUNCHER_WEB_DIR, 'server.js'))) {
  const archiver = require('archiver');

  app.get('/download/launcher-web', (req, res) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="claude-launcher-web.zip"');

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);

    // Add all project files with claude-launcher-web/ prefix
    archive.glob('**/*', {
      cwd: LAUNCHER_WEB_DIR,
      ignore: ['node_modules/**', 'data/**', '*.log'],
      dot: false,
    }, { prefix: 'claude-launcher-web/' });

    archive.finalize();
  });
  console.log('Claude Launcher Web disponivel em /download/launcher-web');
} else {
  console.log('Claude Launcher Web NAO encontrado em', LAUNCHER_WEB_DIR);
}

// ─── Launcher health check proxy ───
app.get('/api/instances/:id/launcher-status', async (req, res) => {
  try {
    const instance = await vultr.getInstance(req.params.id);
    if (!instance.ip || instance.ip === '0.0.0.0') {
      return res.json({ online: false, reason: 'No IP' });
    }
    // Try to reach the launcher health endpoint
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`http://${instance.ip}:3001/api/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok) {
        const data = await response.json();
        return res.json({ online: true, ...data });
      }
      res.json({ online: false, reason: `HTTP ${response.status}` });
    } catch (fetchErr) {
      clearTimeout(timeout);
      res.json({ online: false, reason: fetchErr.message });
    }
  } catch (err) {
    res.status(500).json({ online: false, error: err.message });
  }
});

// ─── Start ───
app.listen(PORT, () => {
  console.log(`Vultr VM Manager rodando em http://localhost:${PORT}`);
  if (tunnelUrl) {
    console.log(`Cloudflare tunnel: ${tunnelUrl}`);
  } else {
    console.log('Nenhum tunnel detectado. Tentando iniciar...');
    ensureTunnel();
  }
});
