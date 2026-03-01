// ─── Clipboard Helper (HTTP fallback) ───
function copyText(text) {
  if (navigator.clipboard && copyText) {
    copyText(text).catch(() => copyFallback(text));
  } else {
    copyFallback(text);
  }
}
function copyFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

// ─── Utility ───
function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') e.className = v;
      else if (k === 'textContent') e.textContent = v;
      else if (k === 'innerHTML') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else e.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else if (c) e.appendChild(c);
  }
  return e;
}

// ─── Toast ───
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = el('div', { className: `toast toast-${type}`, textContent: message });
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; }, 3000);
  setTimeout(() => toast.remove(), 3500);
}

// ─── Modal ───
function showModal(title, contentFn) {
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  content.innerHTML = '';
  content.appendChild(el('h3', { textContent: title }));
  contentFn(content);
  overlay.classList.remove('hidden');
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// ─── Auth Form ───
function renderAuthForm(container, onSuccess) {
  container.innerHTML = '';
  const view = el('div', { className: 'auth-view' });
  const card = el('div', { className: 'auth-card' });

  card.appendChild(el('h2', { textContent: 'Vultr VM Manager', style: 'text-align: center; color: var(--vultr); margin-bottom: 4px;' }));
  card.appendChild(el('p', { textContent: 'Faca login ou crie sua conta', style: 'text-align: center; color: var(--text-muted); font-size: 13px; margin-bottom: 24px;' }));

  let isLogin = true;

  const emailInput = el('input', { type: 'email', id: 'auth-email', placeholder: 'seu@email.com' });
  const passwordInput = el('input', { type: 'password', id: 'auth-password', placeholder: 'Senha (min 6 caracteres)' });
  const confirmInput = el('input', { type: 'password', id: 'auth-confirm', placeholder: 'Confirmar senha' });
  const confirmGroup = el('div', { className: 'form-group', id: 'confirm-group', style: 'display: none;' },
    el('label', { textContent: 'Confirmar Senha' }),
    confirmInput,
  );

  const errorMsg = el('div', { id: 'auth-error', style: 'color: var(--red); font-size: 13px; margin-bottom: 12px; display: none;' });

  const submitBtn = el('button', {
    className: 'btn btn-action',
    id: 'auth-submit',
    textContent: 'Entrar',
    style: 'width: 100%;',
    onClick: async () => {
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      errorMsg.style.display = 'none';

      if (!email || !password) {
        errorMsg.textContent = 'Email e senha obrigatorios';
        errorMsg.style.display = 'block';
        return;
      }

      if (!isLogin) {
        if (password !== confirmInput.value) {
          errorMsg.textContent = 'Senhas nao conferem';
          errorMsg.style.display = 'block';
          return;
        }
        if (password.length < 6) {
          errorMsg.textContent = 'Senha deve ter no minimo 6 caracteres';
          errorMsg.style.display = 'block';
          return;
        }
      }

      submitBtn.disabled = true;
      submitBtn.textContent = isLogin ? 'Entrando...' : 'Cadastrando...';

      try {
        let user;
        if (isLogin) {
          user = await API.login(email, password);
        } else {
          await API.register(email, password);
          user = await API.login(email, password);
        }
        onSuccess(user);
      } catch (err) {
        errorMsg.textContent = err.message;
        errorMsg.style.display = 'block';
      }

      submitBtn.disabled = false;
      submitBtn.textContent = isLogin ? 'Entrar' : 'Cadastrar';
    },
  });

  const toggleLink = el('a', {
    href: '#',
    id: 'auth-toggle',
    textContent: 'Nao tem conta? Cadastre-se',
    style: 'display: block; text-align: center; margin-top: 16px; font-size: 13px; color: var(--vultr); cursor: pointer;',
    onClick: (e) => {
      e.preventDefault();
      isLogin = !isLogin;
      submitBtn.textContent = isLogin ? 'Entrar' : 'Cadastrar';
      toggleLink.textContent = isLogin ? 'Nao tem conta? Cadastre-se' : 'Ja tem conta? Faca login';
      confirmGroup.style.display = isLogin ? 'none' : 'block';
      errorMsg.style.display = 'none';
    },
  });

  card.appendChild(el('div', { className: 'form-group' }, el('label', { textContent: 'Email' }), emailInput));
  card.appendChild(el('div', { className: 'form-group' }, el('label', { textContent: 'Senha' }), passwordInput));
  card.appendChild(confirmGroup);
  card.appendChild(errorMsg);
  card.appendChild(submitBtn);
  card.appendChild(toggleLink);

  view.appendChild(card);
  container.appendChild(view);

  emailInput.focus();
}

// ─── Limits Bar ───
function renderLimitsBar(limits) {
  const bar = el('div', { className: 'limits-bar', id: 'limits-bar' });

  const winUsed = limits.usedWindows || 0;
  const linuxUsed = limits.usedLinux || 0;
  const winMax = limits.maxWindows || 3;
  const linuxMax = limits.maxLinux || 3;

  bar.appendChild(el('span', { textContent: 'Limites: ', style: 'font-weight: 600; font-size: 13px;' }));
  bar.appendChild(el('span', {
    className: `limit-tag ${winUsed >= winMax ? 'limit-full' : ''}`,
    textContent: `Windows: ${winUsed}/${winMax}`,
  }));
  bar.appendChild(el('span', {
    className: `limit-tag ${linuxUsed >= linuxMax ? 'limit-full' : ''}`,
    textContent: `Linux: ${linuxUsed}/${linuxMax}`,
  }));

  return bar;
}

// ─── Status Badge ───
function statusBadge(status, powerStatus) {
  let cls = 'badge-unknown';
  let text = status;

  if (powerStatus === 'running' && status === 'active') {
    cls = 'badge-running';
    text = 'Running';
  } else if (powerStatus === 'stopped') {
    cls = 'badge-stopped';
    text = 'Stopped';
  } else if (status === 'pending') {
    cls = 'badge-pending';
    text = 'Pending';
  } else if (status === 'active' && powerStatus !== 'running') {
    cls = 'badge-stopped';
    text = powerStatus || status;
  }

  return el('span', { className: `badge ${cls}`, textContent: text });
}

// ─── Detect if instance is Windows ───
function isWindowsInstance(instance) {
  return (instance.os || '').toLowerCase().includes('windows');
}

// ─── Instance Card ───
function renderInstanceCard(instance, onAction, showOwner) {
  const isRunning = instance.powerStatus === 'running';
  const isStopped = instance.powerStatus === 'stopped';
  const isWin = isWindowsInstance(instance);

  const actions = el('div', { className: 'vm-card-actions' });

  if (isRunning) {
    // Claude Web button (opens launcher web on port 3001) - for both Windows and Linux
    if (instance.ip && instance.ip !== '0.0.0.0') {
      const claudeWebBtn = el('button', {
        className: 'btn btn-action btn-sm',
        textContent: 'Claude Web',
        style: 'background: #89b4fa; color: #1e1e2e; border-color: #89b4fa; font-weight: 600;',
        onClick: () => {
          window.open(`http://${instance.ip}:3001`, '_blank');
        },
      });
      // Check launcher status
      authFetch(`/api/instances/${instance.id}/launcher-status`)
        .then(r => r.json())
        .then(data => {
          if (data.online) {
            claudeWebBtn.title = `Online - ${data.activeSessions || 0} sessoes ativas`;
            claudeWebBtn.style.background = '#a6e3a1';
            claudeWebBtn.style.borderColor = '#a6e3a1';
          } else {
            claudeWebBtn.title = 'Offline - ' + (data.reason || 'nao disponivel');
            claudeWebBtn.style.opacity = '0.6';
          }
        })
        .catch(() => { claudeWebBtn.style.opacity = '0.6'; });
      actions.appendChild(claudeWebBtn);
    }

    if (isWin) {
      actions.appendChild(el('a', {
        className: 'btn btn-action btn-sm',
        href: API.getRdpUrl(instance.id),
        download: `${instance.label}.rdp`,
        textContent: 'RDP',
      }));
    } else {
      // SSH copy button for Linux
      actions.appendChild(el('button', {
        className: 'btn btn-action btn-sm',
        textContent: 'Copiar SSH',
        onClick: () => {
          const cmd = `ssh root@${instance.ip}`;
          copyText(cmd);
          showToast('Comando SSH copiado: ' + cmd, 'success');
        },
      }));
    }
    actions.appendChild(el('button', {
      className: 'btn btn-outline btn-sm',
      textContent: 'Parar',
      onClick: () => onAction('stop', instance),
    }));
    actions.appendChild(el('button', {
      className: 'btn btn-outline btn-sm',
      textContent: 'Reboot',
      onClick: () => onAction('reboot', instance),
    }));
  }

  if (isStopped) {
    actions.appendChild(el('button', {
      className: 'btn btn-action btn-sm',
      textContent: 'Iniciar',
      onClick: () => onAction('start', instance),
    }));
  }

  actions.appendChild(el('button', {
    className: 'btn btn-danger btn-sm',
    textContent: 'Deletar',
    onClick: () => onAction('delete', instance),
  }));

  // OS type indicator
  const osTag = el('span', {
    className: isWin ? 'os-tag os-windows' : 'os-tag os-linux',
    textContent: isWin ? 'WIN' : 'LNX',
  });

  const infoSection = el('div', { className: 'vm-card-info' },
    infoRow('IP', instance.ip && instance.ip !== '0.0.0.0' ? instance.ip : 'Aguardando...'),
    infoRow('OS', instance.os || '-'),
    infoRow('Plano', instance.plan || '-'),
    infoRow('Regiao', instance.region || '-'),
    infoRow('vCPU/RAM', `${instance.vcpuCount || '?'} vCPU / ${instance.ram ? (instance.ram >= 1024 ? (instance.ram / 1024) + ' GB' : instance.ram + ' MB') : '?'}`),
    infoRow('Senha', instance.defaultPassword || '-'),
    infoRow('ID', instance.id),
  );

  if (showOwner && instance.ownerEmail) {
    infoSection.appendChild(infoRow('Dono', instance.ownerEmail));
  } else if (showOwner && !instance.ownerEmail) {
    infoSection.appendChild(infoRow('Dono', 'sem dono'));
  }

  return el('div', { className: 'vm-card', dataset: { id: instance.id } },
    el('div', { className: 'vm-card-header' },
      el('div', { style: 'display: flex; align-items: center; gap: 8px;' },
        osTag,
        el('span', { className: 'vm-card-name', textContent: instance.label || instance.hostname }),
      ),
      statusBadge(instance.status, instance.powerStatus)
    ),
    infoSection,
    actions
  );
}

function infoRow(label, value) {
  const row = el('div', { className: 'vm-info-row' },
    el('span', { className: 'label', textContent: label }),
    el('span', { className: 'value', textContent: value })
  );

  if (label === 'IP' || label === 'Senha' || label === 'ID') {
    row.style.cursor = 'pointer';
    row.title = 'Clique para copiar';
    row.addEventListener('click', () => {
      copyText(value);
      showToast(`${label} copiado!`, 'success');
    });
  }

  return row;
}

// ─── Instance Grid ───
function renderInstanceGrid(instances, container, onAction, showOwner) {
  container.innerHTML = '';

  if (instances.length === 0) {
    container.appendChild(el('div', { className: 'empty-state' },
      el('div', { innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' }),
      el('h3', { textContent: 'Nenhuma instancia encontrada' }),
      el('p', { textContent: 'Clique em "+ Nova VM" para criar sua primeira maquina virtual.' }),
    ));
    return;
  }

  const grid = el('div', { className: 'vm-grid' });
  for (const inst of instances) {
    grid.appendChild(renderInstanceCard(inst, onAction, showOwner));
  }
  container.appendChild(grid);
}

// ─── Create Form ───
function renderCreateForm(options, container, onSubmit, onCancel) {
  container.innerHTML = '';
  const view = el('div', { className: 'create-view' });

  view.appendChild(el('h2', { textContent: 'Criar VMs' }));

  const form = el('form');
  form.onsubmit = (e) => { e.preventDefault(); };

  // OS Type toggle (Windows / Linux)
  const osTypeRow = el('div', { className: 'os-type-toggle' });
  const btnWin = el('button', {
    type: 'button', className: 'os-toggle-btn active', id: 'toggle-windows',
    textContent: 'Windows',
    onClick: () => switchOSType('windows'),
  });
  const btnLinux = el('button', {
    type: 'button', className: 'os-toggle-btn', id: 'toggle-linux',
    textContent: 'Linux',
    onClick: () => switchOSType('linux'),
  });
  osTypeRow.appendChild(btnWin);
  osTypeRow.appendChild(btnLinux);
  form.appendChild(el('div', { className: 'form-group' },
    el('label', { textContent: 'Tipo de OS' }),
    osTypeRow,
  ));

  // Label / Name prefix
  form.appendChild(formGroup('Nome / Label', el('input', {
    type: 'text', id: 'f-label', placeholder: 'minha-vm', maxlength: '25',
  }), 'Prefixo do nome. Se criar varias, sera: nome-01, nome-02, ...'));

  // Quantity
  const countInput = el('input', {
    type: 'number', id: 'f-count', value: '1', min: '1', max: '20',
  });
  const countHint = el('div', { className: 'hint', id: 'f-count-hint', textContent: 'Numero de VMs a criar (1-20)' });
  const countGroup = el('div', { className: 'form-group' });
  const countLabel = el('label');
  countLabel.innerHTML = 'Quantidade <span class="required">*</span>';
  countGroup.appendChild(countLabel);
  countGroup.appendChild(countInput);
  countGroup.appendChild(countHint);
  form.appendChild(countGroup);

  // Region
  const regionSelect = el('select', { id: 'f-region' });
  const continents = {};
  for (const r of options.regions) {
    if (!continents[r.continent]) continents[r.continent] = [];
    continents[r.continent].push(r);
  }
  for (const [continent, regions] of Object.entries(continents).sort()) {
    const group = el('optgroup', { label: continent });
    for (const r of regions) {
      group.appendChild(el('option', { value: r.id, textContent: r.desc }));
    }
    regionSelect.appendChild(group);
  }
  const samRegion = options.regions.find(r => r.id === 'sao');
  if (samRegion) regionSelect.value = 'sao';
  form.appendChild(formGroup('Regiao', regionSelect));

  // OS Select (dynamic based on type)
  const osSelect = el('select', { id: 'f-os' });
  form.appendChild(formGroup('Sistema Operacional', osSelect));

  // Plan (filtered by selected region)
  const planSelect = el('select', { id: 'f-plan' });
  function updatePlansForRegion() {
    const regionId = regionSelect.value;
    planSelect.innerHTML = '';
    const available = options.plans.filter(p => !p.locations || p.locations.includes(regionId));
    for (const p of available) {
      planSelect.appendChild(el('option', { value: p.id, textContent: `${p.id} - ${p.desc}` }));
    }
    if (available.length === 0) {
      planSelect.appendChild(el('option', { value: '', textContent: 'Nenhum plano disponivel nesta regiao' }));
    }
  }
  regionSelect.addEventListener('change', updatePlansForRegion);
  updatePlansForRegion();
  form.appendChild(formGroup('Plano', planSelect));

  // Bootstrap section
  const claudeCheckbox = el('input', { type: 'checkbox', id: 'f-install-claude' });
  claudeCheckbox.checked = true;
  const hasLauncherWeb = options.launcherWebAvailable && options.tunnelAvailable;
  const bootstrapText = hasLauncherWeb
    ? 'Instalar Git + Node.js + Claude Code + Claude Web Launcher (via remoto apos boot)'
    : 'Instalar Git + Node.js + Claude Code (via remoto apos boot)';
  const claudeLabel = el('label', {
    className: 'checkbox-label',
    style: 'display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;',
  },
    claudeCheckbox,
    el('span', { id: 'bootstrap-desc', textContent: bootstrapText }),
  );

  // Launcher Web status indicator
  const launcherStatus = el('div', {
    style: `margin-top: 6px; font-size: 11px; padding: 4px 8px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; ${hasLauncherWeb ? 'background: #dcfce7; color: #15803d;' : 'background: #fef3c7; color: #92400e;'}`,
    innerHTML: hasLauncherWeb
      ? '&#9679; Claude Web Launcher disponivel (acesso via http://IP:3001 - crie conta no primeiro acesso)'
      : '&#9679; Claude Web Launcher nao disponivel (tunnel ou projeto nao encontrado)',
  });

  const pwdInput = el('input', {
    type: 'password', id: 'f-password', placeholder: 'Senha do Administrator (min 8 chars)',
  });
  const pwdRow = el('div', { className: 'password-row' },
    pwdInput,
    el('button', {
      type: 'button',
      className: 'btn btn-outline btn-sm',
      textContent: 'Gerar',
      onClick: () => { pwdInput.value = generatePassword(); pwdInput.type = 'text'; },
    }),
    el('button', {
      type: 'button',
      className: 'btn btn-outline btn-sm btn-icon',
      innerHTML: '&#128065;',
      onClick: () => { pwdInput.type = pwdInput.type === 'password' ? 'text' : 'password'; },
    }),
  );

  const pwdGroup = el('div', { id: 'pwd-group', style: 'margin-top: 10px;' },
    el('label', { style: 'display: block; font-size: 12px; font-weight: 500; margin-bottom: 4px;' }, 'Senha Administrator'),
    pwdRow,
    el('div', { className: 'hint', textContent: 'Define a senha do Administrator via WinRM apos provisionamento' }),
  );

  const claudeGroup = el('div', {
    className: 'form-group',
    id: 'bootstrap-group',
    style: 'padding: 12px; background: #f0f2ff; border: 1px solid #b3c0f7; border-radius: var(--radius);',
  },
    el('label', { style: 'display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--vultr);' },
      'Bootstrap'),
    claudeLabel,
    launcherStatus,
    pwdGroup,
  );

  claudeCheckbox.addEventListener('change', () => {
    document.getElementById('pwd-group').style.display = claudeCheckbox.checked ? 'block' : 'none';
  });

  form.appendChild(claudeGroup);

  // OS type switch logic
  function switchOSType(type) {
    const winBtn = document.getElementById('toggle-windows');
    const linuxBtn = document.getElementById('toggle-linux');
    const osSelectEl = document.getElementById('f-os');
    const pwdGroupEl = document.getElementById('pwd-group');
    const bootstrapDesc = document.getElementById('bootstrap-desc');

    winBtn.className = 'os-toggle-btn' + (type === 'windows' ? ' active' : '');
    linuxBtn.className = 'os-toggle-btn' + (type === 'linux' ? ' active' : '');

    osSelectEl.innerHTML = '';
    const osList = type === 'windows' ? options.windowsOS : options.linuxOS;

    if (type === 'linux') {
      // Group by family
      const families = {};
      for (const o of osList) {
        const fam = o.family || 'other';
        if (!families[fam]) families[fam] = [];
        families[fam].push(o);
      }
      for (const [fam, items] of Object.entries(families).sort()) {
        const group = el('optgroup', { label: fam });
        for (const o of items) {
          group.appendChild(el('option', { value: o.id, textContent: `${o.name} (${o.arch})` }));
        }
        osSelectEl.appendChild(group);
      }
      // Default to Ubuntu 24.04
      const ubuntu = osList.find(o => o.name.includes('Ubuntu 24.04'));
      if (ubuntu) osSelectEl.value = ubuntu.id;

      pwdGroupEl.style.display = 'none';
      bootstrapDesc.textContent = hasLauncherWeb
        ? 'Instalar Git + Node.js + Claude Code + Claude Web Launcher (via remoto apos boot)'
        : 'Instalar Git + Node.js + Claude Code (via remoto apos boot)';
    } else {
      for (const o of osList) {
        osSelectEl.appendChild(el('option', { value: o.id, textContent: `${o.name} (${o.arch})` }));
      }
      // Default to Win 2022 Standard
      const win2022 = osList.find(o => o.name.includes('2022 Standard') && !o.name.includes('Core'));
      if (win2022) osSelectEl.value = win2022.id;

      const checked = document.getElementById('f-install-claude').checked;
      pwdGroupEl.style.display = checked ? 'block' : 'none';
      bootstrapDesc.textContent = hasLauncherWeb
        ? 'Instalar Git + Node.js + Claude Code + Claude Web Launcher + definir senha (via WinRM)'
        : 'Instalar Git + Node.js + Claude Code + definir senha (via remoto apos boot)';
    }

    // Update count limits
    const countHintEl = document.getElementById('f-count-hint');
    const countInputEl = document.getElementById('f-count');
    if (options.limits) {
      const remaining = type === 'windows'
        ? (options.limits.maxWindows - (options.limits.usedWindows || 0))
        : (options.limits.maxLinux - (options.limits.usedLinux || 0));
      const max = Math.max(0, remaining);
      countInputEl.max = max;
      if (parseInt(countInputEl.value) > max) countInputEl.value = max;
      countHintEl.textContent = `Maximo: ${max} VM(s) ${type === 'windows' ? 'Windows' : 'Linux'} restantes`;
      if (max === 0) countHintEl.style.color = 'var(--red)';
      else countHintEl.style.color = '';
    }

    // Store current type
    osSelectEl.dataset.osType = type;
  }

  // Actions
  const actions = el('div', { className: 'form-actions' });
  actions.appendChild(el('button', {
    className: 'btn btn-action',
    textContent: 'Criar VM(s)',
    onClick: () => {
      const osType = document.getElementById('f-os').dataset.osType || 'windows';
      const data = {
        label: document.getElementById('f-label').value.trim(),
        count: parseInt(document.getElementById('f-count').value) || 1,
        region: document.getElementById('f-region').value,
        osId: document.getElementById('f-os').value,
        plan: document.getElementById('f-plan').value,
        installClaude: document.getElementById('f-install-claude').checked,
        adminPassword: document.getElementById('f-password').value,
        osType,
      };

      if (!data.label) {
        showToast('Nome/Label obrigatorio', 'error');
        return;
      }
      if (data.installClaude && osType === 'windows' && (!data.adminPassword || data.adminPassword.length < 8)) {
        showToast('Senha do Administrator deve ter no minimo 8 caracteres', 'error');
        return;
      }
      onSubmit(data);
    },
  }));
  actions.appendChild(el('button', {
    className: 'btn btn-outline',
    textContent: 'Cancelar',
    onClick: onCancel,
  }));
  form.appendChild(actions);

  view.appendChild(form);
  container.appendChild(view);

  // Initialize OS list
  switchOSType('windows');
}

function formGroup(labelText, input, hint) {
  const group = el('div', { className: 'form-group' });
  const label = el('label');
  label.innerHTML = labelText + ' <span class="required">*</span>';
  group.appendChild(label);
  group.appendChild(input);
  if (hint) group.appendChild(el('div', { className: 'hint', textContent: hint }));
  return group;
}

function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%&*';
  const all = upper + lower + digits + special;
  let pwd = '';
  pwd += upper[Math.floor(Math.random() * upper.length)];
  pwd += lower[Math.floor(Math.random() * lower.length)];
  pwd += digits[Math.floor(Math.random() * digits.length)];
  pwd += special[Math.floor(Math.random() * special.length)];
  for (let i = 4; i < 16; i++) pwd += all[Math.floor(Math.random() * all.length)];
  return pwd.split('').sort(() => Math.random() - 0.5).join('');
}

// ─── Progress Tracker ───
function renderProgressTracker(container, title, totalSteps) {
  container.innerHTML = '';
  const view = el('div', { className: 'progress-view' });
  view.appendChild(el('h2', { textContent: title }));

  const steps = el('div', { className: 'progress-steps', id: 'progress-steps' });
  view.appendChild(steps);
  view.appendChild(el('div', { className: 'progress-elapsed', id: 'progress-elapsed', textContent: 'Tempo: 0s' }));

  container.appendChild(view);

  const startTime = Date.now();
  const timer = setInterval(() => {
    const elapsed = document.getElementById('progress-elapsed');
    if (elapsed) elapsed.textContent = `Tempo: ${Math.round((Date.now() - startTime) / 1000)}s`;
    else clearInterval(timer);
  }, 1000);

  const stepElements = {};

  return {
    updateStep(data) {
      const stepId = `step-${data.step}`;

      if (!stepElements[stepId]) {
        const stepEl = el('div', {
          className: 'progress-step',
          id: stepId,
        },
          el('div', { className: 'step-indicator pending', id: `${stepId}-ind`, textContent: data.step }),
          el('div', {},
            el('div', { className: 'step-label', id: `${stepId}-label`, textContent: data.label || `Passo ${data.step}` }),
            el('div', { className: 'step-detail', id: `${stepId}-detail`, textContent: 'Pendente' }),
          ),
        );
        steps.appendChild(stepEl);
        stepElements[stepId] = true;
      }

      const stepEl = document.getElementById(stepId);
      const indEl = document.getElementById(`${stepId}-ind`);
      const labelEl = document.getElementById(`${stepId}-label`);
      const detailEl = document.getElementById(`${stepId}-detail`);
      if (!stepEl) return;

      stepEl.className = 'progress-step ' + (data.status === 'done' ? 'done' : data.status === 'in_progress' ? 'active' : '');
      indEl.className = 'step-indicator ' + (data.status === 'done' ? 'done' : data.status === 'in_progress' ? 'active' : 'pending');

      if (data.label) labelEl.textContent = data.label;

      if (data.status === 'in_progress') {
        indEl.innerHTML = '<div class="spinner spinner-sm"></div>';
        detailEl.textContent = data.detail || 'Processando...';
      } else if (data.status === 'done') {
        indEl.innerHTML = '&#10003;';
        detailEl.textContent = data.detail || 'Concluido';
      }
    },
    stopTimer() { clearInterval(timer); },
  };
}

// ─── Success View ───
function renderSuccessView(container, result) {
  container.innerHTML = '';
  const view = el('div', { className: 'success-view' });

  view.appendChild(el('div', { className: 'success-icon', innerHTML: '&#10003;' }));

  const count = result.instances.length;
  view.appendChild(el('h2', { textContent: count > 1 ? `${count} VMs Criadas!` : 'VM Criada!' }));

  for (const inst of result.instances) {
    const isWin = (inst.os || '').toLowerCase().includes('windows');
    const details = el('div', { className: 'success-details', style: 'margin-bottom: 16px;' });

    const headerRow = el('div', { className: 'detail-row-header' },
      el('span', { className: isWin ? 'os-tag os-windows' : 'os-tag os-linux', textContent: isWin ? 'WIN' : 'LNX', style: 'margin-right: 8px;' }),
      document.createTextNode(inst.label || inst.hostname),
    );
    details.appendChild(headerRow);

    const rows = [
      ['IP', inst.ip],
      ['Senha', inst.defaultPassword],
      ['OS', inst.os],
      ['Plano', inst.plan],
      ['Regiao', inst.region],
      ['ID', inst.id],
    ];
    for (const [label, value] of rows) {
      const row = el('div', { className: 'detail-row' },
        el('span', { className: 'detail-label', textContent: label }),
        el('span', { className: 'detail-value', textContent: value || '-' }),
      );
      if (label === 'IP' || label === 'Senha') {
        row.style.cursor = 'pointer';
        row.title = 'Clique para copiar';
        row.addEventListener('click', () => {
          copyText(value);
          showToast(`${label} copiado!`, 'success');
        });
      }
      details.appendChild(row);
    }

    // Claude Web Launcher prominent link
    if (inst.ip && inst.ip !== '0.0.0.0' && result.installClaude && result.hasLauncherWeb) {
      const webUrl = `http://${inst.ip}:3001`;
      const webLauncherBox = el('div', {
        style: 'margin-top: 12px; padding: 12px; background: linear-gradient(135deg, #1e3a5f, #1e1e2e); border: 1px solid #89b4fa; border-radius: 8px;',
      });
      webLauncherBox.appendChild(el('div', {
        style: 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;',
        innerHTML: '<span style="font-size: 18px;">&#127760;</span><strong style="color: #89b4fa; font-size: 14px;">Claude Web Launcher</strong>',
      }));
      const urlRow = el('div', {
        style: 'display: flex; align-items: center; gap: 8px; margin-bottom: 6px;',
      });
      urlRow.appendChild(el('a', {
        href: webUrl,
        target: '_blank',
        textContent: webUrl,
        style: 'color: #89b4fa; font-size: 14px; font-weight: 600; text-decoration: underline;',
      }));
      urlRow.appendChild(el('button', {
        className: 'btn btn-outline btn-sm',
        textContent: 'Abrir',
        style: 'border-color: #89b4fa; color: #89b4fa;',
        onClick: () => window.open(webUrl, '_blank'),
      }));
      webLauncherBox.appendChild(urlRow);
      webLauncherBox.appendChild(el('div', {
        style: 'font-size: 12px; color: #a6adc8;',
        innerHTML: '<strong>Primeiro acesso:</strong> crie usuario e senha ao abrir o link',
      }));
      details.appendChild(webLauncherBox);
    }

    const cardActions = el('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; padding-top: 12px; border-top: 1px solid var(--border);' });
    if (isWin) {
      cardActions.appendChild(el('a', {
        className: 'btn btn-action btn-sm',
        href: API.getRdpUrl(inst.id),
        download: `${inst.label}.rdp`,
        textContent: 'Download RDP',
      }));
    } else {
      cardActions.appendChild(el('button', {
        className: 'btn btn-action btn-sm',
        textContent: 'Copiar SSH',
        onClick: () => {
          copyText(`ssh root@${inst.ip}`);
          showToast('SSH copiado!', 'success');
        },
      }));
    }
    cardActions.appendChild(el('button', {
      className: 'btn btn-outline btn-sm',
      textContent: 'Copiar Senha',
      onClick: () => { copyText(inst.defaultPassword); showToast('Senha copiada!', 'success'); },
    }));
    cardActions.appendChild(el('button', {
      className: 'btn btn-outline btn-sm',
      textContent: 'Copiar IP',
      onClick: () => { copyText(inst.ip); showToast('IP copiado!', 'success'); },
    }));
    details.appendChild(cardActions);

    view.appendChild(details);
  }

  view.appendChild(el('div', { className: 'success-elapsed', textContent: `Tempo total: ${result.elapsed}s` }));

  const actions = el('div', { className: 'success-actions' });
  actions.appendChild(el('button', {
    className: 'btn btn-outline',
    textContent: 'Voltar ao Dashboard',
    onClick: () => window.app.showDashboard(),
  }));
  view.appendChild(actions);

  container.appendChild(view);
}

// ─── Delete Confirm Modal ───
function showDeleteModal(instance, onConfirm) {
  showModal(`Deletar: ${instance.label}`, (content) => {
    content.appendChild(el('p', {
      textContent: `Isso vai deletar permanentemente a instancia "${instance.label}" (${instance.id}). Esta acao e irreversivel.`,
      style: 'margin-bottom: 16px; font-size: 14px; color: var(--text-muted);',
    }));

    const input = el('input', {
      type: 'text',
      placeholder: 'Digite DELETAR para confirmar',
      style: 'width: 100%; height: 40px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius); font-size: 14px;',
    });
    content.appendChild(formGroup('Confirmacao', input));

    const act = el('div', { className: 'modal-actions' });
    act.appendChild(el('button', { className: 'btn btn-outline', textContent: 'Cancelar', onClick: closeModal }));
    act.appendChild(el('button', {
      className: 'btn btn-danger',
      textContent: 'Deletar',
      onClick: () => {
        if (input.value !== 'DELETAR') {
          showToast('Digite DELETAR para confirmar', 'error');
          return;
        }
        closeModal();
        onConfirm();
      },
    }));
    content.appendChild(act);
  });
}

// ─── Batch Delete Modal ───
function showBatchDeleteModal(instances, onConfirm) {
  showModal(`Deletar ${instances.length} instancias`, (content) => {
    content.appendChild(el('p', {
      textContent: `Isso vai deletar permanentemente ${instances.length} instancias. Esta acao e irreversivel.`,
      style: 'margin-bottom: 12px; font-size: 14px; color: var(--text-muted);',
    }));

    const list = el('ul', { style: 'margin-bottom: 16px; font-size: 13px; color: var(--text-muted); list-style: disc; padding-left: 20px;' });
    for (const inst of instances) {
      list.appendChild(el('li', { textContent: `${inst.label} (${inst.ip || 'sem IP'})` }));
    }
    content.appendChild(list);

    const input = el('input', {
      type: 'text',
      placeholder: 'Digite DELETAR para confirmar',
      style: 'width: 100%; height: 40px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius); font-size: 14px;',
    });
    content.appendChild(formGroup('Confirmacao', input));

    const act = el('div', { className: 'modal-actions' });
    act.appendChild(el('button', { className: 'btn btn-outline', textContent: 'Cancelar', onClick: closeModal }));
    act.appendChild(el('button', {
      className: 'btn btn-danger',
      textContent: `Deletar ${instances.length} instancias`,
      onClick: () => {
        if (input.value !== 'DELETAR') {
          showToast('Digite DELETAR para confirmar', 'error');
          return;
        }
        closeModal();
        onConfirm();
      },
    }));
    content.appendChild(act);
  });
}
