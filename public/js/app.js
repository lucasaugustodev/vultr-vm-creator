// ─── App State ───
let options = null;
let instances = [];
let currentView = 'dashboard';
let refreshTimer = null;
let actionInProgress = new Set();
let selectedInstances = new Set();

// ─── Init ───
async function init() {
  try {
    options = await API.getOptions();
  } catch (err) {
    showToast('Erro ao carregar opcoes: ' + err.message, 'error');
  }
  renderNav();
  showDashboard();
}

// ─── Navigation ───
function renderNav() {
  const nav = document.getElementById('nav-actions');
  nav.innerHTML = '';
  nav.appendChild(el('button', {
    className: 'btn btn-primary',
    textContent: '+ Nova VM',
    onClick: showCreateView,
  }));
}

// ─── Dashboard View ───
async function showDashboard() {
  currentView = 'dashboard';
  selectedInstances.clear();
  const app = document.getElementById('app');
  app.innerHTML = '';

  const header = el('div', { className: 'dashboard-header' });
  header.appendChild(el('h2', { textContent: 'Suas Instancias' }));

  const headerActions = el('div', { style: 'display: flex; align-items: center; gap: 12px;' });
  headerActions.appendChild(el('span', { className: 'refresh-info', id: 'refresh-info', textContent: '' }));
  headerActions.appendChild(el('button', {
    className: 'btn btn-danger btn-sm',
    id: 'btn-batch-delete',
    textContent: 'Deletar Selecionadas',
    style: 'display: none;',
    onClick: handleBatchDelete,
  }));
  headerActions.appendChild(el('button', {
    className: 'btn btn-outline btn-sm',
    textContent: 'Atualizar',
    onClick: () => refreshInstances(),
  }));
  header.appendChild(headerActions);
  app.appendChild(header);

  const content = el('div', { id: 'instance-list' });
  content.appendChild(el('div', { className: 'loading-full' },
    el('div', { className: 'spinner', style: 'margin-right: 8px;' }),
    'Carregando instancias...'
  ));
  app.appendChild(content);

  await refreshInstances();
  startAutoRefresh();
}

async function refreshInstances() {
  if (currentView !== 'dashboard') return;
  const content = document.getElementById('instance-list');
  if (!content) return;

  try {
    instances = await API.listInstances();
    renderInstanceGrid(instances, content, handleInstanceAction);
    const info = document.getElementById('refresh-info');
    if (info) info.textContent = `${instances.length} instancia(s) - atualizado ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    content.innerHTML = '';
    content.appendChild(el('div', { className: 'empty-state' },
      el('h3', { textContent: 'Erro ao carregar instancias' }),
      el('p', { textContent: err.message }),
      el('button', { className: 'btn btn-action', textContent: 'Tentar novamente', onClick: refreshInstances }),
    ));
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(refreshInstances, 30000);
}

function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// ─── Instance Actions ───
async function handleInstanceAction(action, instance) {
  if (actionInProgress.has(instance.id) && action !== 'select') {
    showToast('Aguarde a acao anterior terminar', 'info');
    return;
  }

  switch (action) {
    case 'start':
      actionInProgress.add(instance.id);
      showToast(`Iniciando "${instance.label}"...`, 'info');
      try {
        await API.startInstance(instance.id);
        showToast(`"${instance.label}" iniciada!`, 'success');
      } catch (err) {
        showToast(`Erro: ${err.message}`, 'error');
      }
      actionInProgress.delete(instance.id);
      refreshInstances();
      break;

    case 'stop':
      actionInProgress.add(instance.id);
      showToast(`Parando "${instance.label}"...`, 'info');
      try {
        await API.stopInstance(instance.id);
        showToast(`"${instance.label}" parada!`, 'success');
      } catch (err) {
        showToast(`Erro: ${err.message}`, 'error');
      }
      actionInProgress.delete(instance.id);
      refreshInstances();
      break;

    case 'reboot':
      actionInProgress.add(instance.id);
      showToast(`Reiniciando "${instance.label}"...`, 'info');
      try {
        await API.rebootInstance(instance.id);
        showToast(`"${instance.label}" reiniciada!`, 'success');
      } catch (err) {
        showToast(`Erro: ${err.message}`, 'error');
      }
      actionInProgress.delete(instance.id);
      refreshInstances();
      break;

    case 'delete':
      showDeleteModal(instance, async () => {
        actionInProgress.add(instance.id);
        showToast(`Deletando "${instance.label}"...`, 'info');
        try {
          await API.deleteInstance(instance.id);
          showToast(`"${instance.label}" deletada!`, 'success');
        } catch (err) {
          showToast(`Erro: ${err.message}`, 'error');
        }
        actionInProgress.delete(instance.id);
        refreshInstances();
      });
      break;
  }
}

// ─── Batch Delete ───
async function handleBatchDelete() {
  const selected = instances.filter(i => selectedInstances.has(i.id));
  if (selected.length === 0) return;

  showBatchDeleteModal(selected, async () => {
    showToast(`Deletando ${selected.length} instancias...`, 'info');
    try {
      const result = await API.deleteInstances(selected.map(i => i.id));
      if (result.success) {
        showToast(`${result.deleted} instancias deletadas!`, 'success');
      } else {
        showToast(`${result.deleted} deletadas, ${result.failed.length} falharam`, 'error');
      }
    } catch (err) {
      showToast(`Erro: ${err.message}`, 'error');
    }
    selectedInstances.clear();
    refreshInstances();
  });
}

// ─── Create View ───
function showCreateView() {
  currentView = 'create';
  stopAutoRefresh();
  const app = document.getElementById('app');
  renderCreateForm(options, app, handleCreateSubmit, showDashboard);
}

async function handleCreateSubmit(data) {
  const app = document.getElementById('app');
  currentView = 'creating';

  try {
    const { taskId, totalSteps } = await API.createInstances(data);
    const title = data.count > 1 ? `Criando ${data.count} VMs...` : `Criando VM: ${data.label}`;
    const tracker = renderProgressTracker(app, title, totalSteps);

    API.subscribeProgress(taskId, {
      onProgress(step) {
        tracker.updateStep(step);
      },
      onComplete(result) {
        tracker.stopTimer();
        setTimeout(() => renderSuccessView(app, result), 500);
      },
      onError(err) {
        tracker.stopTimer();
        showToast(`Erro na criacao: ${err.message}`, 'error');
      },
    });
  } catch (err) {
    showToast(`Erro: ${err.message}`, 'error');
    showCreateView();
  }
}

// ─── Expose for components ───
window.app = { showDashboard };

// ─── Start ───
document.addEventListener('DOMContentLoaded', init);
