const { Client } = require('ssh2');
const { execFile } = require('child_process');

// ═══════════════════════════════════════════
// PowerShell Remote (WinRM Negotiate - native)
// Uses powershell.exe Invoke-Command which supports
// Negotiate auth for the built-in Administrator account
// ═══════════════════════════════════════════

function psRemoteExec(host, password, psCommand, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    // Build a PS script that creates credential and runs Invoke-Command
    // On Linux (pwsh), SkipRevocationCheck is not supported, and we use -Authentication Negotiate
    const isLinux = process.platform !== 'win32';
    const sessionOpts = isLinux
      ? `$so = New-PSSessionOption -SkipCACheck -SkipCNCheck`
      : `$so = New-PSSessionOption -SkipCACheck -SkipCNCheck -SkipRevocationCheck`;
    const authParam = isLinux ? '-Authentication Negotiate' : '';

    const script = `
$ErrorActionPreference = 'Continue'
$pw = '${password.replace(/'/g, "''")}'
$secpwd = ConvertTo-SecureString $pw -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('Administrator', $secpwd)
${sessionOpts}
try {
  $session = New-PSSession -ComputerName ${host} -Credential $cred -SessionOption $so ${authParam} -ErrorAction Stop
  $result = Invoke-Command -Session $session -ScriptBlock {
    ${psCommand}
  } -ErrorAction Stop 2>&1
  $result | ForEach-Object { Write-Output $_ }
  Remove-PSSession $session -ErrorAction SilentlyContinue
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`;

    const timer = setTimeout(() => {
      reject(new Error(`PS Remote timeout (${timeoutMs/1000}s)`));
    }, timeoutMs);

    const psExe = isLinux ? 'pwsh' : 'powershell.exe';
    execFile(psExe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (err && err.killed) {
        return reject(new Error('Command killed (timeout)'));
      }
      resolve({
        code: err ? err.code || 1 : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    });
  });
}

function psRemoteConnect({ host, password, retries = 40, retryDelay = 15000, onAttempt }) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    async function tryConnect() {
      attempt++;
      if (onAttempt) onAttempt(attempt, retries);

      try {
        const result = await psRemoteExec(host, password, 'Write-Output "CONNECTED"', 20000);
        if (result.stdout && result.stdout.includes('CONNECTED')) {
          resolve({ host, password });
          return;
        }
        // Check if it's an auth error vs connection error
        const errMsg = result.stderr || result.stdout || '';
        if (errMsg.includes('Access is denied')) {
          // Auth error - won't fix itself with retries
          reject(new Error('WinRM Access denied - senha incorreta ou UAC bloqueando'));
          return;
        }
        throw new Error(errMsg || 'Unexpected response');
      } catch (err) {
        if (err.message.includes('Access is denied')) {
          reject(err);
          return;
        }
        if (attempt < retries) {
          setTimeout(tryConnect, retryDelay);
        } else {
          reject(new Error(`WinRM failed after ${retries} attempts: ${err.message}`));
        }
      }
    }
    tryConnect();
  });
}

// ═══════════════════════════════════════════
// SSH (for Linux)
// ═══════════════════════════════════════════

function sshConnect({ host, username, password, port = 22, retries = 30, retryDelay = 10000 }) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    function tryConnect() {
      attempt++;
      const conn = new Client();
      const timeout = setTimeout(() => {
        conn.destroy();
        if (attempt < retries) setTimeout(tryConnect, retryDelay);
        else reject(new Error(`SSH timeout after ${retries} attempts`));
      }, 15000);

      conn.on('ready', () => { clearTimeout(timeout); resolve(conn); });
      conn.on('error', (err) => {
        clearTimeout(timeout);
        conn.destroy();
        if (attempt < retries) setTimeout(tryConnect, retryDelay);
        else reject(new Error(`SSH failed after ${retries} attempts: ${err.message}`));
      });

      conn.connect({
        host, port, username, password,
        readyTimeout: 15000,
        algorithms: {
          kex: ['ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
                'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256',
                'diffie-hellman-group14-sha1'],
          serverHostKey: ['ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-ed25519', 'rsa-sha2-256', 'rsa-sha2-512'],
        },
        hostVerifier: () => true,
      });
    }
    tryConnect();
  });
}

function sshExec(conn, command, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timer = setTimeout(() => reject(new Error(`Timeout: ${command.slice(0, 60)}`)), timeoutMs);
    conn.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      stream.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
    });
  });
}

// ═══════════════════════════════════════════
// Provision Windows (via PowerShell Remoting)
// ═══════════════════════════════════════════

async function provisionWindows(connInfo, { adminPassword, onStep }) {
  const { host, password } = connInfo;
  const steps = [];

  // Step 1: Enable RDP (before password change)
  steps.push({
    label: 'Habilitar RDP',
    command: `
      Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name 'fDenyTSConnections' -Value 0
      Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue
      Write-Output 'RDP enabled'
    `,
  });

  // Step 2: Install Git (PortableGit zip extraction - no installer, works over WinRM)
  steps.push({
    label: 'Instalar Git',
    command: `
      $gitDir = 'C:\\Program Files\\Git'
      if (Test-Path "$gitDir\\bin\\bash.exe") { Write-Output 'Git already installed'; return }
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Write-Output 'Downloading PortableGit...'
      $url = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/PortableGit-2.47.1.2-64-bit.7z.exe'
      $exePath = 'C:\\portablegit.7z.exe'
      Invoke-WebRequest -Uri $url -OutFile $exePath -UseBasicParsing
      Write-Output 'Extracting...'
      New-Item -ItemType Directory -Path $gitDir -Force -ErrorAction SilentlyContinue | Out-Null
      & $exePath -o"$gitDir" -y 2>&1 | Select-Object -Last 2
      Start-Sleep -Seconds 5
      Remove-Item $exePath -Force -ErrorAction SilentlyContinue
      if (Test-Path "$gitDir\\bin\\bash.exe") {
        Write-Output 'Git installed (bash.exe OK)'
      } else {
        Write-Output 'WARNING: Git install may have failed'
      }
    `,
    timeout: 300000,
  });

  // Step 3: Install Node.js
  steps.push({
    label: 'Instalar Node.js',
    command: `
      if (Get-Command node -ErrorAction SilentlyContinue) { Write-Output 'Node.js already installed'; return }
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Write-Output 'Downloading Node.js...'
      Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi' -OutFile C:\\node-installer.msi -UseBasicParsing
      Write-Output 'Installing Node.js...'
      Start-Process msiexec.exe -ArgumentList '/i C:\\node-installer.msi /qn /norestart ADDLOCAL=ALL' -Wait -NoNewWindow
      Remove-Item C:\\node-installer.msi -Force -ErrorAction SilentlyContinue
      Write-Output 'Node.js installed'
    `,
    timeout: 180000,
  });

  // Step 4: Update PATH + set CLAUDE_CODE_GIT_BASH_PATH
  steps.push({
    label: 'Configurar PATH e env vars',
    command: `
      $p = [System.Environment]::GetEnvironmentVariable('Path','Machine')
      $changed = $false
      if ($p -notlike '*Git\\cmd*') { $p = 'C:\\Program Files\\Git\\cmd;' + $p; $changed = $true }
      if ($p -notlike '*Git\\bin*') { $p = 'C:\\Program Files\\Git\\bin;' + $p; $changed = $true }
      if ($p -notlike '*nodejs*') { $p = 'C:\\Program Files\\nodejs;' + $p; $changed = $true }
      if ($changed) { [System.Environment]::SetEnvironmentVariable('Path', $p, 'Machine') }
      # Claude Code on Windows requires git-bash - set the env var so it can find it
      $gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
      [System.Environment]::SetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', $gitBash, 'Machine')
      Write-Output "PATH updated, CLAUDE_CODE_GIT_BASH_PATH=$gitBash"
    `,
  });

  // Step 5: Install Claude Code
  steps.push({
    label: 'Instalar Claude Code',
    command: `
      $env:Path = 'C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\bin;' + [System.Environment]::GetEnvironmentVariable('Path','Machine')
      Write-Output 'Installing Claude Code...'
      & 'C:\\Program Files\\nodejs\\npm.cmd' install -g @anthropic-ai/claude-code 2>&1 | Select-Object -Last 5
      $npmGlobal = & 'C:\\Program Files\\nodejs\\npm.cmd' prefix -g 2>&1
      $p = [System.Environment]::GetEnvironmentVariable('Path','Machine')
      if ($p -notlike ('*' + $npmGlobal + '*')) {
        $p = $npmGlobal + ';' + $p
        [System.Environment]::SetEnvironmentVariable('Path', $p, 'Machine')
      }
      Write-Output 'Claude Code installed'
    `,
    timeout: 300000,
  });

  // Step 6: Install Cline CLI
  steps.push({
    label: 'Instalar Cline CLI',
    command: `
      $env:Path = 'C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\bin;' + [System.Environment]::GetEnvironmentVariable('Path','Machine')
      Write-Output 'Installing Cline CLI...'
      & 'C:\\Program Files\\nodejs\\npm.cmd' install -g cline 2>&1 | Select-Object -Last 5
      Write-Output 'Cline CLI installed'
    `,
    timeout: 180000,
  });

  // Step 7: Install Claude Launcher Web (clone from GitHub - git already installed)
  steps.push({
    label: 'Instalar Claude Launcher Web',
    command: `
      $env:Path = 'C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\bin;' + [System.Environment]::GetEnvironmentVariable('Path','Machine')
      $launcherDir = 'C:\\claude-launcher-web'
      if (Test-Path "$launcherDir\\server.js") { Write-Output 'Launcher Web already installed'; return }

      Write-Output 'Cloning Claude Launcher Web from GitHub...'
      & 'C:\\Program Files\\Git\\cmd\\git.exe' clone https://github.com/lucasaugustodev/claude-launcher-web.git $launcherDir 2>&1 | Select-Object -Last 3

      if (-not (Test-Path "$launcherDir\\server.js")) { Write-Output 'ERROR: Clone failed'; return }

      Write-Output 'Installing npm dependencies...'
      Set-Location $launcherDir
      & 'C:\\Program Files\\nodejs\\npm.cmd' install --production 2>&1 | Select-Object -Last 3

      # Create scheduled task to auto-start on boot
      $taskName = 'ClaudeLauncherWeb'
      $nodeExe = 'C:\\Program Files\\nodejs\\node.exe'
      $action = New-ScheduledTaskAction -Execute $nodeExe -Argument 'server.js' -WorkingDirectory $launcherDir
      $trigger = New-ScheduledTaskTrigger -AtStartup
      $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -DontStopIfGoingOnBatteries
      $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
      Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null

      # Create auto-update scheduled task (runs every 10 minutes)
      $updateTaskName = 'ClaudeLauncherWebUpdate'
      $psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      $updateScript = Join-Path $launcherDir 'update.ps1'
      $updateAction = New-ScheduledTaskAction -Execute $psExe -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $updateScript + '"') -WorkingDirectory $launcherDir
      $updateTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)
      $updateSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
      $updatePrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      Unregister-ScheduledTask -TaskName $updateTaskName -Confirm:$false -ErrorAction SilentlyContinue
      Register-ScheduledTask -TaskName $updateTaskName -Action $updateAction -Trigger $updateTrigger -Settings $updateSettings -Principal $updatePrincipal | Out-Null

      # Open firewall port 3001
      New-NetFirewallRule -DisplayName 'Claude Launcher Web' -Direction Inbound -LocalPort 3001 -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null

      # Start the service now
      Start-ScheduledTask -TaskName $taskName
      Start-Sleep -Seconds 3
      Write-Output 'Claude Launcher Web installed with auto-update (every 10 min) on port 3001'
    `,
    timeout: 300000,
  });

  // Step 8: Desktop shortcut
  steps.push({
    label: 'Criar atalhos Desktop',
    command: `
      $lines = @('@echo off','title Claude Code','echo ========================================','echo   Claude Code - Primeiro Acesso','echo ========================================','echo.','echo Siga as instrucoes para autenticar.','echo.','claude','pause')
      $bat = $lines -join [Environment]::NewLine
      Set-Content -Path 'C:\\Users\\Public\\Desktop\\Iniciar Claude.bat' -Value $bat -Encoding ASCII
      $dir = 'C:\\Users\\Administrator\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup'
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      Set-Content -Path (Join-Path $dir 'Iniciar Claude.bat') -Value $bat -Encoding ASCII
      Write-Output 'Shortcuts created'
    `,
  });

  // Step 8 (LAST): Set custom password (must be last since it invalidates WinRM credentials)
  if (adminPassword && adminPassword !== password) {
    steps.push({
      label: 'Definir senha admin',
      command: `
        net user Administrator '${adminPassword.replace(/'/g, "''")}'
        Write-Output 'Password changed'
      `,
    });
  }

  // Execute steps
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (onStep) onStep({ index: i, total: steps.length, label: step.label, status: 'in_progress', detail: 'Executando...' });

    try {
      const result = await psRemoteExec(host, password, step.command, step.timeout || 120000);
      const output = (result.stdout || result.stderr || '').slice(-300);

      if (onStep) onStep({
        index: i, total: steps.length, label: step.label,
        status: result.code === 0 ? 'done' : 'warning',
        detail: result.code === 0 ? (output || 'OK') : `Exit ${result.code}: ${output}`,
      });
      results.push({ label: step.label, result });
    } catch (err) {
      if (onStep) onStep({ index: i, total: steps.length, label: step.label, status: 'error', detail: err.message });
      results.push({ label: step.label, error: err.message });
    }
  }
  return results;
}

// ═══════════════════════════════════════════
// Provision Linux (via SSH)
// ═══════════════════════════════════════════

async function provisionLinux(conn, { adminPassword, onStep }) {
  const steps = [
    {
      label: 'Instalar Git',
      command: `bash -c 'if command -v git &>/dev/null; then echo "Git: $(git --version)"; exit 0; fi; echo "Installing Git..."; if command -v apt-get &>/dev/null; then export DEBIAN_FRONTEND=noninteractive && apt-get update -y && apt-get install -y git; elif command -v dnf &>/dev/null; then dnf install -y git; elif command -v yum &>/dev/null; then yum install -y git; fi; echo "Git: $(git --version 2>/dev/null || echo failed)"'`,
      timeout: 120000,
    },
    {
      label: 'Instalar Node.js',
      command: `bash -c 'if command -v node &>/dev/null; then echo "Node: $(node --version)"; exit 0; fi; echo "Installing Node.js..."; if command -v apt-get &>/dev/null; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; elif command -v dnf &>/dev/null; then curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && dnf install -y nodejs; fi; echo "Node: $(node --version 2>/dev/null || echo failed)"'`,
      timeout: 180000,
    },
    {
      label: 'Instalar Claude Code',
      command: `bash -c 'if ! command -v npm &>/dev/null; then echo "npm not found"; exit 1; fi; echo "Installing Claude Code..."; npm install -g @anthropic-ai/claude-code 2>&1 | tail -3; echo "Claude: $(claude --version 2>/dev/null || echo check PATH)"'`,
      timeout: 300000,
    },
    {
      label: 'Instalar Cline CLI',
      command: `bash -c 'echo "Installing Cline CLI..."; npm install -g cline 2>&1 | tail -3; echo "Cline: $(cline --version 2>/dev/null || echo check PATH)"'`,
      timeout: 180000,
    },
  ];

  // Always install Claude Launcher Web on Linux (clone from GitHub)
  // Runs as dedicated 'claude' user so --dangerously-skip-permissions works (blocked as root)
  steps.push({
    label: 'Instalar Claude Launcher Web',
    command: `bash -c '
set -e
if [ -f /opt/claude-launcher-web/server.js ]; then echo "Launcher Web already installed"; exit 0; fi

# Create dedicated claude user (non-root so bypass mode works)
if ! id claude &>/dev/null; then
  useradd -m -s /bin/bash claude
  echo "claude ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/claude
  chmod 440 /etc/sudoers.d/claude
  echo "User claude created with sudo for package installs"
fi

echo "Cloning Claude Launcher Web from GitHub..."
git clone https://github.com/lucasaugustodev/claude-launcher-web.git /opt/claude-launcher-web
chown -R claude:claude /opt/claude-launcher-web

cd /opt/claude-launcher-web
sudo -u claude npm install --production 2>&1 | tail -5

# Install Claude Code globally for the claude user
sudo -u claude npm install -g @anthropic-ai/claude-code 2>&1 | tail -3

# Make update script executable
chmod +x /opt/claude-launcher-web/update.sh

# Create systemd service running as claude user
cat > /etc/systemd/system/claude-launcher-web.service << EOSVC
[Unit]
Description=Claude Launcher Web
After=network.target
[Service]
Type=simple
User=claude
Group=claude
WorkingDirectory=/opt/claude-launcher-web
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=3001
Environment=HOME=/home/claude
[Install]
WantedBy=multi-user.target
EOSVC

# Create systemd timer for auto-update (every 10 minutes)
cat > /etc/systemd/system/claude-launcher-update.service << EOSVC
[Unit]
Description=Claude Launcher Web Auto-Update
[Service]
Type=oneshot
User=claude
Group=claude
WorkingDirectory=/opt/claude-launcher-web
ExecStart=/opt/claude-launcher-web/update.sh
Environment=HOME=/home/claude
EOSVC

cat > /etc/systemd/system/claude-launcher-update.timer << EOSVC
[Unit]
Description=Auto-update Claude Launcher Web every 10 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
EOSVC

systemctl daemon-reload
systemctl enable claude-launcher-web
systemctl start claude-launcher-web
systemctl enable claude-launcher-update.timer
systemctl start claude-launcher-update.timer
# Open firewall
ufw allow 3001/tcp 2>/dev/null || firewall-cmd --permanent --add-port=3001/tcp 2>/dev/null && firewall-cmd --reload 2>/dev/null || iptables -I INPUT -p tcp --dport 3001 -j ACCEPT 2>/dev/null || true
sleep 2
echo "Claude Launcher Web installed with auto-update (every 10 min) on port 3001 (as user claude)"
'`,
    timeout: 300000,
  });

  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (onStep) onStep({ index: i, total: steps.length, label: step.label, status: 'in_progress', detail: 'Executando...' });
    try {
      const result = await sshExec(conn, step.command, step.timeout || 120000);
      const output = (result.stdout || result.stderr || '').slice(-200);
      if (onStep) onStep({
        index: i, total: steps.length, label: step.label,
        status: result.code === 0 ? 'done' : 'warning',
        detail: result.code === 0 ? (output || 'OK') : `Exit ${result.code}: ${output}`,
      });
      results.push({ label: step.label, result });
    } catch (err) {
      if (onStep) onStep({ index: i, total: steps.length, label: step.label, status: 'error', detail: err.message });
      results.push({ label: step.label, error: err.message });
    }
  }
  return results;
}

// ═══════════════════════════════════════════
// Main provision function
// ═══════════════════════════════════════════

async function provision({ host, password, isWindows, adminPassword, onStep, onStatus }) {
  if (isWindows) {
    if (onStatus) onStatus(`Conectando via WinRM (Negotiate) em ${host}...`);

    const connInfo = await psRemoteConnect({
      host, password,
      retries: 40, retryDelay: 15000,
      onAttempt: (attempt, total) => {
        if (onStatus) onStatus(`WinRM tentativa ${attempt}/${total} em ${host}...`);
      },
    });

    if (onStatus) onStatus('WinRM conectado! Iniciando provisionamento...');
    return await provisionWindows(connInfo, { adminPassword, onStep });
  } else {
    if (onStatus) onStatus(`Conectando via SSH em ${host}...`);

    const conn = await sshConnect({ host, username: 'root', password, retries: 30, retryDelay: 10000 });

    if (onStatus) onStatus('SSH conectado! Iniciando provisionamento...');
    try {
      return await provisionLinux(conn, { adminPassword, onStep });
    } finally {
      conn.end();
    }
  }
}

module.exports = { provision, sshConnect, sshExec, psRemoteExec, psRemoteConnect };
