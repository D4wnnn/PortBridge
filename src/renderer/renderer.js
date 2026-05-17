const defaults = {
  server: '',
  localPort: '7890',
  remotePort: '7890',
  direction: 'remote-to-local'
};

let profiles = [];
let selectedId = null;
const states = new Map();
const logs = new Map();

const fields = ['server', 'localPort', 'remotePort'];
const $ = (id) => document.getElementById(id);

function createProfile(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    ...defaults,
    ...overrides
  };
}

function cleanPort(value, fallback) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 5);
  return digits || fallback;
}

function getSelectedProfile() {
  return profiles.find((profile) => profile.id === selectedId) || null;
}

function normalizeProfile(profile) {
  return {
    id: profile.id || crypto.randomUUID(),
    server: profile.server || profile.sshTarget || '',
    localPort: cleanPort(profile.localPort, '7890'),
    remotePort: cleanPort(profile.remotePort, '7890'),
    direction: profile.direction === 'local-to-remote' ? 'local-to-remote' : 'remote-to-local'
  };
}

function profileTitle(profile) {
  if (!profile) return '端口映射';

  const server = profile.server || '服务器';
  const arrow = profile.direction === 'remote-to-local' ? '->' : '<-';
  return `${server}  ${profile.remotePort || '?'} ${arrow} ${profile.localPort || '?'}`;
}

function profileFromForm() {
  const current = getSelectedProfile() || createProfile();
  const next = { ...current };

  for (const field of fields) {
    next[field] = $(field).value.trim();
  }

  return normalizeProfile(next);
}

function sshCommand(profile) {
  if (!profile) return '';

  if (profile.direction === 'local-to-remote') {
    return `ssh -N -L ${profile.localPort}:127.0.0.1:${profile.remotePort} ${profile.server || '<server>'}`;
  }

  return `ssh -N -R ${profile.remotePort}:127.0.0.1:${profile.localPort} ${profile.server || '<server>'}`;
}

function envPreview(profile) {
  const port = profile?.direction === 'local-to-remote' ? profile.localPort : profile?.remotePort;
  return `export http_proxy=http://127.0.0.1:${port || '7890'}\nexport https_proxy=http://127.0.0.1:${port || '7890'}\nexport all_proxy=socks5://127.0.0.1:${port || '7890'}`;
}

function setStatus(profileId, nextState) {
  states.set(profileId, { ...(states.get(profileId) || {}), ...nextState });
  renderProfiles();
  renderStatus();
}

function appendLog(profileId, line) {
  const current = logs.get(profileId) || '';
  logs.set(profileId, `${current}${line.endsWith('\n') ? line : `${line}\n`}`);
  renderLog();
}

function renderProfiles() {
  const list = $('profileList');
  list.innerHTML = '';

  for (const profile of profiles) {
    const state = states.get(profile.id)?.state;
    const button = document.createElement('button');
    button.className = [
      'profile-item',
      profile.id === selectedId ? 'active' : '',
      state === 'running' ? 'running' : ''
    ].filter(Boolean).join(' ');
    button.type = 'button';
    button.innerHTML = `
      <strong>${escapeHtml(profile.server || '未命名服务器')}</strong>
      <span>${escapeHtml(profileTitle(profile))}</span>
    `;
    button.addEventListener('click', () => selectProfile(profile.id));
    list.appendChild(button);
  }
}

function renderForm() {
  const profile = getSelectedProfile();
  if (!profile) return;

  $('server').value = profile.server || '';
  $('localPort').value = profile.localPort || '';
  $('remotePort').value = profile.remotePort || '';
  $('pageTitle').textContent = profileTitle(profile);

  renderDirection(profile);
  renderPreview();
  renderStatus();
  renderLog();
}

function renderDirection(profile) {
  const isRemoteToLocal = profile.direction !== 'local-to-remote';
  $('directionArrow').textContent = isRemoteToLocal ? '\u2190' : '\u2192';
  $('directionText').textContent = isRemoteToLocal ? '远程到本地' : '本地到远程';
}

function renderPreview() {
  const profile = profileFromForm();
  renderDirection(profile);
  $('commandPreview').textContent = sshCommand(profile);
  $('envTitle').textContent = profile.direction === 'local-to-remote' ? '本机环境变量' : '远程环境变量';
  $('envPreview').textContent = envPreview(profile);
}

function renderStatus() {
  const state = states.get(selectedId) || { state: 'idle' };
  const labels = {
    idle: '未连接',
    starting: '启动中',
    running: '已连接',
    reconnecting: '重连中',
    stopped: '已停止',
    error: '连接失败'
  };

  $('statusDot').className = `status-dot ${state.state || 'idle'}`;
  $('statusLabel').textContent = labels[state.state] || labels.idle;
  $('pidLabel').textContent = state.pid ? `PID ${state.pid}` : '';
}

function renderLog() {
  $('logOutput').textContent = logs.get(selectedId) || '';
  $('logOutput').scrollTop = $('logOutput').scrollHeight;
}

function selectProfile(id) {
  selectedId = id;
  renderProfiles();
  renderForm();
}

async function saveCurrentProfile() {
  const next = profileFromForm();
  const index = profiles.findIndex((profile) => profile.id === next.id);

  if (index >= 0) {
    profiles[index] = next;
  } else {
    profiles.push(next);
    selectedId = next.id;
  }

  profiles = (await window.portBridge.saveProfiles(profiles)).map(normalizeProfile);
  renderProfiles();
  renderForm();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function init() {
  profiles = (await window.portBridge.loadProfiles()).map(normalizeProfile);

  if (profiles.length === 0) {
    profiles = [createProfile()];
    await window.portBridge.saveProfiles(profiles);
  }

  selectedId = profiles[0].id;
  $('configPath').textContent = `配置保存于 ${await window.portBridge.configPath()}`;
  $('autoLaunch').checked = await window.portBridge.getAutoLaunch();

  const activeStates = await window.portBridge.tunnelStates();
  for (const state of activeStates) setStatus(state.profileId, state);

  renderProfiles();
  renderForm();
}

for (const field of fields) {
  $(field).addEventListener('input', () => {
    if (field.endsWith('Port')) {
      $(field).value = $(field).value.replace(/\D/g, '').slice(0, 5);
    }
    renderPreview();
  });
}

$('directionToggle').addEventListener('click', () => {
  const current = getSelectedProfile();
  if (!current) return;
  current.direction = current.direction === 'local-to-remote' ? 'remote-to-local' : 'local-to-remote';
  renderPreview();
});

$('newProfile').addEventListener('click', async () => {
  const profile = createProfile();
  profiles.push(profile);
  selectedId = profile.id;
  await window.portBridge.saveProfiles(profiles);
  renderProfiles();
  renderForm();
});

$('duplicateProfile').addEventListener('click', async () => {
  const copy = createProfile({ ...profileFromForm(), id: crypto.randomUUID() });
  profiles.push(copy);
  selectedId = copy.id;
  await window.portBridge.saveProfiles(profiles);
  renderProfiles();
  renderForm();
});

$('deleteProfile').addEventListener('click', async () => {
  if (profiles.length <= 1) return;
  await window.portBridge.stopTunnel(selectedId);
  profiles = profiles.filter((profile) => profile.id !== selectedId);
  selectedId = profiles[0].id;
  await window.portBridge.saveProfiles(profiles);
  renderProfiles();
  renderForm();
});

$('saveProfile').addEventListener('click', saveCurrentProfile);

$('profileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveCurrentProfile();
});

$('startTunnel').addEventListener('click', async () => {
  await saveCurrentProfile();
  const profile = getSelectedProfile();

  if (!profile.server || !profile.remotePort || !profile.localPort) {
    appendLog(profile.id, '请先填写服务器、本地端口和远程端口。');
    return;
  }

  setStatus(profile.id, { state: 'starting' });
  const result = await window.portBridge.startTunnel(profile);
  if (result.pid) setStatus(profile.id, { state: 'running', pid: result.pid });
});

$('stopTunnel').addEventListener('click', async () => {
  await window.portBridge.stopTunnel(selectedId);
});

$('clearLog').addEventListener('click', () => {
  logs.set(selectedId, '');
  renderLog();
});

$('autoLaunch').addEventListener('change', async () => {
  $('autoLaunch').checked = await window.portBridge.setAutoLaunch($('autoLaunch').checked);
});

window.portBridge.onTunnelStatus((payload) => {
  setStatus(payload.profileId, payload);
});

window.portBridge.onTunnelLog((payload) => {
  appendLog(payload.profileId, payload.line);
});

init();
