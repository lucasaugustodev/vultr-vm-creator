require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const vultr = require('./vultr-service');
const { provision } = require('./provisioner');
const auth = require('./auth');

auth.ensureDataDir();

// Prevent crashes from unhandled errors during provisioning
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED]', err && err.message ? err.message : err);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'JSON invalido' });
  }
  next(err);
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── Allowed OS (filtered) ───
const ALLOWED_OS_NAMES = {
  windows: ['Windows 2022 Standard', 'Windows 2019 Standard', 'Windows 2025 Standard'],
  linux: ['Ubuntu 24.04 LTS x64', 'Ubuntu 22.04 LTS x64', 'Debian 12 x64 (bookworm)'],
};
const MAX_PLAN_COST = 60;

// ─── Auth Middleware ───
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Token obrigatorio' });
  }
  try {
    const payload = auth.verifyToken(header.slice(7));
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Token invalido ou expirado' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Acesso restrito a administradores' });
  }
  next();
}

// ─── Auth Routes ───
app.post('/api/auth/register', async (req, res) => {
  try {
    const user = await auth.registerUser(req.body.email, req.body.password);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const result = await auth.loginUser(req.body.email, req.body.password);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = auth.getUserById(req.user.userId);
  if (!user) return res.status(404).json({ success: false, error: 'Usuario nao encontrado' });
  res.json({ success: true, user });
});

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
app.get('/api/options', requireAuth, async (req, res) => {
  try {
    const [osList, regions, plans] = await Promise.all([
      vultr.getOSList(),
      vultr.getRegions(),
      vultr.getPlans(),
    ]);
    cachedOSForDetection = osList;

    // Filter OS to allowed list
    const filteredWindows = osList.windows.filter(o =>
      ALLOWED_OS_NAMES.windows.some(name => o.name.includes(name.replace(/ x64.*/, '')))
    );
    const filteredLinux = osList.linux.filter(o =>
      ALLOWED_OS_NAMES.linux.some(name => o.name.includes(name.replace(/ x64.*/, '')))
    );

    // Filter plans by max cost and exclude IPv6-only (not available in all regions)
    const filteredPlans = plans.filter(p => p.monthlyCost <= MAX_PLAN_COST && !p.id.includes('-v6'));

    // User limits
    const isAdmin = req.user.role === 'admin';
    const userInstanceIds = auth.getUserInstanceIds(req.user.userId);
    let winCount = 0, linuxCount = 0;
    if (!isAdmin && userInstanceIds.length > 0) {
      try {
        const allInstances = await vultr.listInstances();
        for (const inst of allInstances) {
          if (userInstanceIds.includes(inst.id)) {
            if ((inst.os || '').toLowerCase().includes('windows')) winCount++;
            else linuxCount++;
          }
        }
      } catch {}
    }

    res.json({
      plans: filteredPlans,
      windowsOS: filteredWindows,
      linuxOS: filteredLinux,
      regions,
      launcherWebAvailable: true,
      tunnelAvailable: !!tunnelUrl,
      limits: isAdmin ? null : { maxWindows: 3, maxLinux: 3, usedWindows: winCount, usedLinux: linuxCount },
      isAdmin,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/account ───
app.get('/api/account', requireAuth, requireAdmin, async (req, res) => {
  try {
    const account = await vultr.getAccountInfo();
    res.json({ success: true, data: account });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/instances ───
app.get('/api/instances', requireAuth, async (req, res) => {
  try {
    const instances = await vultr.listInstances();
    const isAdmin = req.user.role === 'admin';

    if (isAdmin) {
      // Admin sees all instances with owner info
      const enriched = instances.map(inst => {
        const ownerId = auth.getInstanceOwner(inst.id);
        let ownerEmail = null;
        if (ownerId) {
          const owner = auth.getUserById(ownerId);
          ownerEmail = owner ? owner.email : 'desconhecido';
        }
        return { ...inst, ownerEmail };
      });
      res.json({ success: true, data: enriched });
    } else {
      // Regular user sees only their instances
      const userIds = auth.getUserInstanceIds(req.user.userId);
      const filtered = instances.filter(inst => userIds.includes(inst.id));
      res.json({ success: true, data: filtered });
    }
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/instances (create single or batch) ───
app.post('/api/instances', requireAuth, async (req, res) => {
  const { label, region, plan, osId, count, installClaude, adminPassword } = req.body;

  if (!label || !region || !plan || !osId) {
    return res.status(400).json({ success: false, error: 'label, region, plan e osId obrigatorios' });
  }

  const qty = Math.min(Math.max(parseInt(count) || 1, 1), 20);
  const isWindows = vultr.isWindowsOS(osId, cachedOSForDetection);

  // Enforce limits for non-admin users
  if (req.user.role !== 'admin') {
    const userIds = auth.getUserInstanceIds(req.user.userId);
    let winCount = 0, linuxCount = 0;
    if (userIds.length > 0) {
      try {
        const allInstances = await vultr.listInstances();
        for (const inst of allInstances) {
          if (userIds.includes(inst.id)) {
            if ((inst.os || '').toLowerCase().includes('windows')) winCount++;
            else linuxCount++;
          }
        }
      } catch {}
    }
    const maxAllowed = isWindows ? (3 - winCount) : (3 - linuxCount);
    if (qty > maxAllowed) {
      const type = isWindows ? 'Windows' : 'Linux';
      return res.status(400).json({ success: false, error: `Limite excedido. Voce pode criar mais ${Math.max(0, maxAllowed)} VM(s) ${type}.` });
    }
  }
  const taskId = crypto.randomUUID();

  // Steps: create(1) + wait(1) + provision steps
  // Windows provision: connect(1) + rdp(1) + git(1) + node(1) + path(1) + claude(1) + cline(1) + launcherWeb(1) + shortcuts(1) + password(1) = 10
  // Linux provision: connect(1) + git(1) + node(1) + claude(1) + cline(1) + launcherWeb(1) = 6
  const winSteps = 10; // connect + rdp + git + node + path + claude + cline + launcherWeb + shortcuts + password
  const linuxSteps = 6; // connect + git + node + claude + cline + launcherWeb (always)
  const provSteps = installClaude ? (isWindows ? winSteps : linuxSteps) : 0;
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

        // Assign ownership immediately (before provisioning, so a server restart doesn't lose it)
        auth.assignInstance(instance.id, req.user.userId);

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

        // Steps 3+: Remote provisioning (when installClaude is checked)
        if (installClaude && ready.ip && ready.ip !== '0.0.0.0') {
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
  // Auth via query param (SSE can't send headers)
  const token = req.query.token;
  if (!token) return res.status(401).json({ success: false, error: 'Token obrigatorio' });
  try { auth.verifyToken(token); } catch { return res.status(401).json({ success: false, error: 'Token invalido' }); }

  const task = tasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ success: false, error: 'Task not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
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

// ─── Ownership check helper ───
function checkOwnership(req, res) {
  if (req.user.role === 'admin') return true;
  const owner = auth.getInstanceOwner(req.params.id);
  if (owner !== req.user.userId) {
    res.status(403).json({ success: false, error: 'Voce nao tem permissao para esta instancia' });
    return false;
  }
  return true;
}

// ─── POST /api/instances/:id/start ───
app.post('/api/instances/:id/start', requireAuth, async (req, res) => {
  if (!checkOwnership(req, res)) return;
  try {
    await vultr.startInstance(req.params.id);
    res.json({ success: true, message: 'Instancia iniciada' });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/instances/:id/stop ───
app.post('/api/instances/:id/stop', requireAuth, async (req, res) => {
  if (!checkOwnership(req, res)) return;
  try {
    await vultr.stopInstance(req.params.id);
    res.json({ success: true, message: 'Instancia parada' });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/instances/:id/reboot ───
app.post('/api/instances/:id/reboot', requireAuth, async (req, res) => {
  if (!checkOwnership(req, res)) return;
  try {
    await vultr.rebootInstance(req.params.id);
    res.json({ success: true, message: 'Instancia reiniciada' });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── DELETE /api/instances/:id ───
app.delete('/api/instances/:id', requireAuth, async (req, res) => {
  if (!checkOwnership(req, res)) return;
  if (!req.body.confirm) {
    return res.status(400).json({ success: false, error: 'Confirmacao necessaria' });
  }
  try {
    await vultr.deleteInstance(req.params.id);
    auth.removeInstance(req.params.id);
    res.json({ success: true, message: 'Instancia deletada' });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ─── DELETE /api/instances (batch delete) ───
app.delete('/api/instances', requireAuth, async (req, res) => {
  const { ids, confirm } = req.body;
  if (!confirm || !ids || !Array.isArray(ids)) {
    return res.status(400).json({ success: false, error: 'ids[] e confirm necessarios' });
  }
  // Check ownership for all ids
  if (req.user.role !== 'admin') {
    const userIds = auth.getUserInstanceIds(req.user.userId);
    const unauthorized = ids.filter(id => !userIds.includes(id));
    if (unauthorized.length > 0) {
      return res.status(403).json({ success: false, error: 'Voce nao tem permissao para algumas instancias' });
    }
  }
  try {
    const results = await Promise.allSettled(
      ids.map(id => vultr.deleteInstance(id))
    );
    // Clean up ownership for successfully deleted
    for (let i = 0; i < ids.length; i++) {
      if (results[i].status === 'fulfilled') auth.removeInstance(ids[i]);
    }
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
app.get('/api/instances/:id/rdp', (req, res, next) => {
  // RDP download is a direct link, support token via query param
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  requireAuth(req, res, next);
}, async (req, res) => {
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
app.get('/api/instances/:id/launcher-status', requireAuth, async (req, res) => {
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

// ─── POST /api/admin/claim-unowned ───
app.post('/api/admin/claim-unowned', requireAuth, requireAdmin, async (req, res) => {
  try {
    const instances = await vultr.listInstances();
    let claimed = 0;
    for (const inst of instances) {
      if (!auth.getInstanceOwner(inst.id)) {
        auth.assignInstance(inst.id, req.user.userId);
        claimed++;
      }
    }
    res.json({ success: true, claimed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
