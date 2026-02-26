require('dotenv').config();
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.VULTR_API_KEY;
const BASE_URL = 'https://api.vultr.com/v2';

// ─── HTTP Helper ───
async function vultrFetch(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (res.status === 204) return null;

  const data = await res.json();
  if (!res.ok) {
    const msg = data.error || data.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

// ─── Plans (fetched from API) ───
let cachedPlans = null;

async function getPlans() {
  if (cachedPlans) return cachedPlans;

  const data = await vultrFetch('/plans?per_page=500');
  cachedPlans = data.plans
    .filter(p => p.type === 'vc2' && p.locations.length > 0)
    .map(p => ({
      id: p.id,
      vcpu: p.vcpu_count,
      ram: p.ram,
      disk: p.disk,
      bandwidth: p.bandwidth,
      monthlyCost: p.monthly_cost,
      type: p.type,
      locations: p.locations,
      desc: `${p.vcpu_count} vCPU, ${p.ram >= 1024 ? (p.ram / 1024) + ' GB' : p.ram + ' MB'} RAM, ${p.disk} GB SSD - $${p.monthly_cost}/mes`,
    }))
    .sort((a, b) => a.monthlyCost - b.monthlyCost);

  return cachedPlans;
}

// ─── OS List (all families) ───
let cachedOS = null;

async function getOSList() {
  if (cachedOS) return cachedOS;

  const data = await vultrFetch('/os?per_page=500');

  // Separate into windows and linux
  const windows = [];
  const linux = [];

  for (const o of data.os) {
    const entry = { id: o.id, name: o.name, arch: o.arch, family: o.family };

    if (o.family === 'windows') {
      windows.push(entry);
    } else if (['ubuntu', 'debian', 'centos', 'fedora', 'rockylinux', 'almalinux', 'archlinux', 'opensuse', 'alpinelinux', 'freebsd', 'flatcar', 'openbsd', 'fedora-coreos'].includes(o.family)) {
      linux.push(entry);
    }
  }

  cachedOS = { windows, linux };
  return cachedOS;
}

// ─── Regions ───
let cachedRegions = null;

async function getRegions() {
  if (cachedRegions) return cachedRegions;

  const data = await vultrFetch('/regions?per_page=500');
  cachedRegions = data.regions
    .map(r => ({
      id: r.id,
      city: r.city,
      country: r.country,
      continent: r.continent,
      desc: `${r.city}, ${r.country} (${r.id})`,
    }))
    .sort((a, b) => a.desc.localeCompare(b.desc));

  return cachedRegions;
}

// ─── Startup Scripts ───
async function createStartupScript(name, script) {
  const data = await vultrFetch('/startup-scripts', {
    method: 'POST',
    body: JSON.stringify({
      name,
      type: 'boot',
      script: Buffer.from(script).toString('base64'),
    }),
  });
  return data.startup_script;
}

async function deleteStartupScript(scriptId) {
  await vultrFetch(`/startup-scripts/${scriptId}`, { method: 'DELETE' });
}

// ─── Startup Script: enables WinRM remote access for provisioning ───
function buildWindowsRemoteEnableScript() {
  return `#ps1
# Enable remote admin access for WinRM Negotiate auth
Set-ItemProperty -Path HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System -Name LocalAccountTokenFilterPolicy -Value 1 -Type DWord -Force
Set-ItemProperty -Path HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System -Name FilterAdministratorToken -Value 0 -Type DWord -Force
# Ensure WinRM is configured
winrm quickconfig -force 2>&1 | Out-Null
Restart-Service WinRM -Force -ErrorAction SilentlyContinue
`;
}

// ─── Build Bootstrap Script (Windows - PowerShell) ───
function buildWindowsBootstrapScript(adminPassword) {
  return `#ps1
$ErrorActionPreference = "Continue"
$logFile = "C:\\bootstrap-log.txt"

function Log($msg) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts - $msg" | Out-File -Append $logFile
  Write-Output $msg
}

Log "=== Bootstrap Started ==="

# Set Administrator password
try {
  net user Administrator "${adminPassword}"
  Log "Administrator password set"
} catch {
  Log "Failed to set password: $_"
}

# Enable RDP
try {
  Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name "fDenyTSConnections" -Value 0
  Enable-NetFirewallRule -DisplayGroup "Remote Desktop"
  Log "RDP enabled"
} catch {
  Log "RDP config: $_"
}

# Install Git
try {
  $gitCmd = Get-Command git -ErrorAction SilentlyContinue
  if (-not $gitCmd) {
    Log "Downloading Git..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe"
    $gitExe = "$env:TEMP\\git-installer.exe"
    Invoke-WebRequest -Uri $gitUrl -OutFile $gitExe -UseBasicParsing
    Start-Process $gitExe -ArgumentList "/VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS" -Wait -NoNewWindow
    Remove-Item $gitExe -Force -ErrorAction SilentlyContinue
    Log "Git installed"
  } else {
    Log "Git already installed"
  }
} catch {
  Log "Git install failed: $_"
}

# Install Node.js
try {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Log "Downloading Node.js..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $nodeUrl = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
    $nodeMsi = "$env:TEMP\\node-installer.msi"
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi -UseBasicParsing
    $msiArgs = '/i "' + $nodeMsi + '" /qn /norestart ADDLOCAL=ALL'
    Start-Process msiexec.exe -ArgumentList $msiArgs -Wait -NoNewWindow
    Remove-Item $nodeMsi -Force -ErrorAction SilentlyContinue
    Log "Node.js installed"
  } else {
    Log "Node.js already installed"
  }
} catch {
  Log "Node.js install failed: $_"
}

# Update PATH
$machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
$changed = $false
if ($machinePath -notlike "*Git\\cmd*") { $machinePath = "C:\\Program Files\\Git\\cmd;$machinePath"; $changed = $true }
if ($machinePath -notlike "*Git\\bin*") { $machinePath = "C:\\Program Files\\Git\\bin;$machinePath"; $changed = $true }
if ($machinePath -notlike "*nodejs*") { $machinePath = "C:\\Program Files\\nodejs;$machinePath"; $changed = $true }
if ($changed) { [System.Environment]::SetEnvironmentVariable("Path", $machinePath, "Machine") }
$env:Path = "$machinePath"

# Install Claude Code CLI
try {
  Log "Installing Claude Code..."
  $env:Path = "C:\\Program Files\\nodejs;$machinePath"
  & "C:\\Program Files\\nodejs\\npm.cmd" install -g @anthropic-ai/claude-code 2>&1 | Out-Null
  $npmGlobal = & "C:\\Program Files\\nodejs\\npm.cmd" prefix -g 2>&1
  if ($machinePath -notlike "*$npmGlobal*") {
    $machinePath = "$npmGlobal;$machinePath"
    [System.Environment]::SetEnvironmentVariable("Path", $machinePath, "Machine")
  }
  Log "Claude Code installed"
} catch {
  Log "Claude Code install failed: $_"
}

# Create desktop shortcut for Claude CLI
try {
  $batContent = @"
@echo off
title Claude Code - Autenticacao
echo ========================================
echo   Claude Code - Primeiro Acesso
echo ========================================
echo.
echo Siga as instrucoes abaixo para autenticar.
echo O navegador vai abrir automaticamente.
echo.
claude
pause
"@
  Set-Content -Path "C:\\Users\\Public\\Desktop\\Iniciar Claude.bat" -Value $batContent -Encoding ASCII
  # Also in Startup folder for auto-launch on RDP login
  $startupDir = "C:\\Users\\Administrator\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"
  if (-not (Test-Path $startupDir)) { New-Item -ItemType Directory -Path $startupDir -Force | Out-Null }
  Set-Content -Path (Join-Path $startupDir "Iniciar Claude.bat") -Value $batContent -Encoding ASCII
  Log "Desktop + Startup shortcuts created"
} catch {
  Log "Desktop shortcut failed: $_"
}

Log "=== Bootstrap Complete ==="
`;
}

// ─── Build Bootstrap Script (Linux - Bash) ───
function buildLinuxBootstrapScript() {
  return `#!/bin/bash
LOG="/var/log/bootstrap.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a $LOG; }

log "=== Bootstrap Started ==="

# Install Git
if ! command -v git &>/dev/null; then
  log "Installing Git..."
  if command -v apt-get &>/dev/null; then
    apt-get update -y && apt-get install -y git
  elif command -v dnf &>/dev/null; then
    dnf install -y git
  elif command -v yum &>/dev/null; then
    yum install -y git
  fi
  log "Git installed: $(git --version 2>/dev/null || echo 'failed')"
else
  log "Git already installed"
fi

# Install Node.js via NodeSource
if ! command -v node &>/dev/null; then
  log "Installing Node.js..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif command -v dnf &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    yum install -y nodejs
  fi
  log "Node.js installed: $(node --version 2>/dev/null || echo 'failed')"
else
  log "Node.js already installed"
fi

# Install Claude Code
if command -v npm &>/dev/null; then
  log "Installing Claude Code..."
  npm install -g @anthropic-ai/claude-code 2>&1 | tail -5
  log "Claude Code installed: $(claude --version 2>/dev/null || echo 'check PATH')"
else
  log "npm not found, skipping Claude Code"
fi

log "=== Bootstrap Complete ==="
`;
}

// ─── Create Instance ───
async function createInstance({ label, region, plan, osId, scriptId, hostname, tag }) {
  const body = {
    region,
    plan,
    os_id: osId,
    label: label || hostname,
    hostname: hostname || label,
    backups: 'disabled',
    enable_ipv6: false,
    tags: tag ? [tag] : [],
  };

  if (scriptId) {
    body.script_id = scriptId;
  }

  const data = await vultrFetch('/instances', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return data.instance;
}

// ─── List Instances ───
async function listInstances(tag) {
  let url = '/instances?per_page=100';
  if (tag) url += `&tag=${encodeURIComponent(tag)}`;
  const data = await vultrFetch(url);
  return (data.instances || []).map(i => ({
    id: i.id,
    label: i.label,
    hostname: i.hostname,
    os: i.os,
    osId: i.os_id,
    plan: i.plan,
    region: i.region,
    ip: i.main_ip,
    v6Ip: i.v6_main_ip,
    status: i.status,
    powerStatus: i.power_status,
    serverStatus: i.server_status,
    ram: i.ram,
    disk: i.disk,
    vcpuCount: i.vcpu_count,
    defaultPassword: i.default_password,
    dateCreated: i.date_created,
    tags: i.tags || [],
  }));
}

// ─── Get Instance ───
async function getInstance(instanceId) {
  const data = await vultrFetch(`/instances/${instanceId}`);
  const i = data.instance;
  return {
    id: i.id,
    label: i.label,
    hostname: i.hostname,
    os: i.os,
    osId: i.os_id,
    plan: i.plan,
    region: i.region,
    ip: i.main_ip,
    status: i.status,
    powerStatus: i.power_status,
    serverStatus: i.server_status,
    ram: i.ram,
    disk: i.disk,
    vcpuCount: i.vcpu_count,
    defaultPassword: i.default_password,
    dateCreated: i.date_created,
    tags: i.tags || [],
  };
}

// ─── Instance Actions ───
async function startInstance(instanceId) {
  await vultrFetch(`/instances/${instanceId}/start`, { method: 'POST' });
}

async function stopInstance(instanceId) {
  await vultrFetch(`/instances/${instanceId}/halt`, { method: 'POST' });
}

async function rebootInstance(instanceId) {
  await vultrFetch(`/instances/${instanceId}/reboot`, { method: 'POST' });
}

async function deleteInstance(instanceId) {
  await vultrFetch(`/instances/${instanceId}`, { method: 'DELETE' });
}

// ─── RDP File Generator ───
function generateRdpContent(ip, username) {
  return [
    'full address:s:' + ip,
    'prompt for credentials:i:1',
    'username:s:' + username,
    'screen mode id:i:2',
    'use multimon:i:0',
    'desktopwidth:i:1920',
    'desktopheight:i:1080',
    'session bpp:i:32',
    'compression:i:1',
    'keyboardhook:i:2',
    'audiocapturemode:i:0',
    'videoplaybackmode:i:1',
    'connection type:i:7',
    'networkautodetect:i:1',
    'bandwidthautodetect:i:1',
    'displayconnectionbar:i:1',
    'disable wallpaper:i:0',
    'allow font smoothing:i:1',
    'allow desktop composition:i:1',
    'redirectclipboard:i:1',
    'redirectprinters:i:0',
    'autoreconnection enabled:i:1',
    'authentication level:i:2',
    'negotiate security layer:i:1',
  ].join('\r\n');
}

// ─── Wait for Instance to be Active ───
async function waitForActive(instanceId, onProgress, timeoutMs = 600000) {
  const start = Date.now();
  let lastStatus = '';

  while (Date.now() - start < timeoutMs) {
    const instance = await getInstance(instanceId);
    const currentStatus = `${instance.status}/${instance.powerStatus}/${instance.serverStatus}`;

    if (currentStatus !== lastStatus) {
      lastStatus = currentStatus;
      if (onProgress) onProgress({
        status: instance.status,
        powerStatus: instance.powerStatus,
        serverStatus: instance.serverStatus,
        ip: instance.ip,
      });
    }

    if (instance.status === 'active' && instance.powerStatus === 'running' && instance.serverStatus === 'ok') {
      return instance;
    }

    await new Promise(r => setTimeout(r, 5000));
  }

  throw new Error('Timeout waiting for instance to become active');
}

// ─── Get Account Info ───
async function getAccountInfo() {
  const data = await vultrFetch('/account');
  return data.account;
}

// ─── Detect if OS is Windows ───
function isWindowsOS(osId, osList) {
  const id = parseInt(osId);
  // Known Windows OS IDs on Vultr
  const knownWindowsIds = [240, 371, 501, 521, 522, 523, 1761, 1762, 1764, 1765, 2514, 2515, 2516, 2517];
  if (knownWindowsIds.includes(id)) return true;
  // Fallback to cached list
  if (osList && osList.windows) {
    return !!osList.windows.find(o => o.id === id);
  }
  return false;
}

module.exports = {
  getPlans,
  getOSList,
  getRegions,
  createStartupScript,
  deleteStartupScript,
  buildWindowsRemoteEnableScript,
  buildWindowsBootstrapScript,
  buildLinuxBootstrapScript,
  isWindowsOS,
  createInstance,
  listInstances,
  getInstance,
  startInstance,
  stopInstance,
  rebootInstance,
  deleteInstance,
  generateRdpContent,
  waitForActive,
  getAccountInfo,
};
