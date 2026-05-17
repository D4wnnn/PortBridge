const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fsSync = require('fs');
const fs = require('fs/promises');
const { spawn } = require('child_process');

const tunnels = new Map();
let mainWindow = null;
let tray = null;
let isQuitting = false;
const reconnectDelayMs = 3000;
const appIconPath = path.join(__dirname, '..', 'assets', 'icon.png');
const trayIconPath = path.join(__dirname, '..', 'assets', 'tray.png');
const startHidden = process.argv.includes('--hidden');
const configFileName = 'profiles.json';
const migrationMarkerFileName = 'profiles.migrated';
const appName = 'PortBridge';
const legacyUserDataNames = ['auto-proxy'];

app.setName(appName);

if (process.platform === 'win32') {
  app.setAppUserModelId(appName);
}

function getConfigPath() {
  return path.join(app.getPath('userData'), configFileName);
}

function getLegacyConfigPaths() {
  const legacyUserDataPaths = legacyUserDataNames.map((name) => path.join(app.getPath('appData'), name, configFileName));

  return [...legacyUserDataPaths, path.join(app.getAppPath(), configFileName), path.join(process.cwd(), configFileName)]
    .filter((filePath, index, paths) => filePath !== getConfigPath() && paths.indexOf(filePath) === index);
}

function profileKey(profile) {
  return [profile.server, profile.localPort, profile.remotePort, profile.direction].map((value) => String(value || '')).join('\0');
}

async function readProfileFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.profiles) ? parsed.profiles : [];
}

async function ensureConfigMigrated() {
  const configPath = getConfigPath();
  const migrationMarkerPath = path.join(app.getPath('userData'), migrationMarkerFileName);
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  let profiles = [];
  let configExists = true;

  try {
    profiles = await readProfileFile(configPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    configExists = false;
  }

  try {
    await fs.access(migrationMarkerPath);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const seenIds = new Set(profiles.map((profile) => profile.id).filter(Boolean));
  const seenProfiles = new Set(profiles.map(profileKey));
  let changed = !configExists;

  for (const legacyPath of getLegacyConfigPaths()) {
    try {
      const legacyProfiles = await readProfileFile(legacyPath);

      for (const profile of legacyProfiles) {
        const key = profileKey(profile);
        if ((profile.id && seenIds.has(profile.id)) || seenProfiles.has(key)) continue;

        profiles.push(profile);
        if (profile.id) seenIds.add(profile.id);
        seenProfiles.add(key);
        changed = true;
      }
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      console.warn(`Could not migrate profiles from ${legacyPath}:`, error);
    }
  }

  if (changed) {
    await fs.writeFile(configPath, JSON.stringify({ profiles }, null, 2), 'utf8');
  }

  await fs.writeFile(migrationMarkerPath, new Date().toISOString(), 'utf8');
}

async function readProfiles() {
  await ensureConfigMigrated();

  try {
    const raw = await fs.readFile(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.profiles) ? parsed.profiles : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeProfiles(profiles) {
  await fs.mkdir(path.dirname(getConfigPath()), { recursive: true });
  await fs.writeFile(getConfigPath(), JSON.stringify({ profiles }, null, 2), 'utf8');
}

function iconFromPath(filePath) {
  return nativeImage.createFromBuffer(fsSync.readFileSync(filePath));
}

function createTrayIcon() {
  return iconFromPath(trayIconPath);
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }

  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function quitApp() {
  isQuitting = true;

  for (const tunnel of tunnels.values()) {
    tunnel.keepAlive = false;
    tunnel.stopping = true;
    clearReconnectTimer(tunnel);
    if (tunnel.child && !tunnel.child.killed) {
      tunnel.child.kill();
    }
  }
  tunnels.clear();

  app.quit();
}

function createTray() {
  if (tray) return;

  tray = new Tray(createTrayIcon());
  tray.setToolTip(appName);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `打开 ${appName}`, click: showMainWindow },
      { type: 'separator' },
      { label: '退出', click: quitApp }
    ])
  );
  tray.on('click', showMainWindow);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 650,
    minWidth: 900,
    minHeight: 560,
    title: appName,
    icon: iconFromPath(appIconPath),
    show: false,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (startHidden) {
      mainWindow.hide();
      return;
    }

    mainWindow.show();
  });

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  createTray();
}

function buildSshArgs(profile) {
  const args = [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3'
  ];

  if (profile.direction === 'local-to-remote') {
    args.push('-L', `${profile.localPort}:127.0.0.1:${profile.remotePort}`);
  } else {
    args.push('-R', `${profile.remotePort}:127.0.0.1:${profile.localPort}`);
  }

  args.push(profile.server);
  return args;
}

function summarizeCommand(profile) {
  return ['ssh', ...buildSshArgs(profile)].join(' ');
}

function emitStatus(profileId, status) {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('tunnel-status', { profileId, ...status });
  });
}

function emitLog(profileId, line) {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('tunnel-log', { profileId, line });
  });
}

function notifyDisconnect(profile, reason) {
  if (!Notification.isSupported()) return;

  new Notification({
    title: `${appName} 连接已断开`,
    body: `${profile.server || '服务器'} 的端口映射已断开，正在自动重连。${reason ? `\n${reason}` : ''}`
  }).show();
}

function getOrCreateTunnel(profile) {
  const existing = tunnels.get(profile.id);
  if (existing) {
    existing.profile = profile;
    return existing;
  }

  const tunnel = {
    profile,
    child: null,
    reconnectTimer: null,
    keepAlive: true,
    stopping: false,
    disconnectNotified: false
  };
  tunnels.set(profile.id, tunnel);
  return tunnel;
}

function clearReconnectTimer(tunnel) {
  if (tunnel.reconnectTimer) {
    clearTimeout(tunnel.reconnectTimer);
    tunnel.reconnectTimer = null;
  }
}

function scheduleReconnect(profile, reason) {
  const tunnel = tunnels.get(profile.id);
  if (!tunnel || !tunnel.keepAlive || tunnel.stopping || isQuitting) return;
  if (tunnel.reconnectTimer) return;

  if (!tunnel.disconnectNotified) {
    notifyDisconnect(profile, reason);
    tunnel.disconnectNotified = true;
  }
  emitStatus(profile.id, { state: 'reconnecting', message: reason });
  emitLog(profile.id, `连接已断开，${reconnectDelayMs / 1000} 秒后自动重连。${reason || ''}`);

  tunnel.reconnectTimer = setTimeout(() => {
    tunnel.reconnectTimer = null;
    if (!tunnel.keepAlive || tunnel.stopping || isQuitting) return;
    startTunnelProcess(tunnel.profile);
  }, reconnectDelayMs);
}

function startTunnelProcess(profile) {
  const tunnel = getOrCreateTunnel(profile);
  clearReconnectTimer(tunnel);
  tunnel.keepAlive = true;
  tunnel.stopping = false;

  if (tunnel.child && !tunnel.child.killed) {
    return { ok: true, command: summarizeCommand(profile), alreadyRunning: true, pid: tunnel.child.pid };
  }

  const args = buildSshArgs(profile);
  const child = spawn('ssh', args, {
    windowsHide: true,
    shell: false
  });

  tunnel.child = child;
  emitStatus(profile.id, { state: 'starting', pid: child.pid, command: summarizeCommand(profile) });
  emitLog(profile.id, `$ ${summarizeCommand(profile)}`);

  child.stdout.on('data', (chunk) => emitLog(profile.id, chunk.toString()));
  child.stderr.on('data', (chunk) => emitLog(profile.id, chunk.toString()));

  child.on('spawn', () => {
    tunnel.disconnectNotified = false;
    emitStatus(profile.id, { state: 'running', pid: child.pid, command: summarizeCommand(profile) });
  });

  child.on('error', (error) => {
    if (tunnel.child === child) tunnel.child = null;
    emitStatus(profile.id, { state: 'error', message: error.message });
    emitLog(profile.id, `启动失败: ${error.message}`);
    scheduleReconnect(profile, error.message);
  });

  child.on('exit', (code, signal) => {
    if (tunnel.child === child) tunnel.child = null;

    const reason = `code=${code ?? ''} signal=${signal ?? ''}`.trim();
    emitLog(profile.id, `连接已结束 ${reason}`);

    if (tunnel.keepAlive && !tunnel.stopping && !isQuitting) {
      scheduleReconnect(profile, reason);
      return;
    }

    emitStatus(profile.id, { state: 'stopped', code, signal });
  });

  return { ok: true, command: summarizeCommand(profile), pid: child.pid };
}

ipcMain.handle('profiles:load', async () => readProfiles());

ipcMain.handle('profiles:save', async (_event, profiles) => {
  await writeProfiles(profiles);
  return readProfiles();
});

ipcMain.handle('profiles:configPath', async () => getConfigPath());

function getAutoLaunchArgs() {
  return process.defaultApp ? [app.getAppPath(), '--hidden'] : ['--hidden'];
}

ipcMain.handle('settings:getAutoLaunch', async () => {
  return app.getLoginItemSettings({
    path: process.execPath,
    args: getAutoLaunchArgs()
  }).openAtLogin;
});

ipcMain.handle('settings:setAutoLaunch', async (_event, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    path: process.execPath,
    args: getAutoLaunchArgs()
  });

  return app.getLoginItemSettings({
    path: process.execPath,
    args: getAutoLaunchArgs()
  }).openAtLogin;
});

ipcMain.handle('tunnel:start', async (_event, profile) => startTunnelProcess(profile));

ipcMain.handle('tunnel:stop', async (_event, profileId) => {
  const tunnel = tunnels.get(profileId);
  if (!tunnel) return { ok: true, alreadyStopped: true };

  tunnel.keepAlive = false;
  tunnel.stopping = true;
  clearReconnectTimer(tunnel);

  if (tunnel.child && !tunnel.child.killed) {
    tunnel.child.kill();
  }

  tunnels.delete(profileId);
  emitStatus(profileId, { state: 'stopped' });
  emitLog(profileId, '已请求停止连接');
  return { ok: true };
});

ipcMain.handle('tunnel:states', async () => {
  return Array.from(tunnels.entries()).map(([profileId, tunnel]) => ({
    profileId,
    pid: tunnel.child?.pid,
    state: tunnel.child ? 'running' : tunnel.reconnectTimer ? 'reconnecting' : 'stopped'
  }));
});

app.whenReady().then(() => {
  createTray();
  createWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', showMainWindow);
