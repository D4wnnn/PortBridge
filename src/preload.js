const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portBridge', {
  loadProfiles: () => ipcRenderer.invoke('profiles:load'),
  saveProfiles: (profiles) => ipcRenderer.invoke('profiles:save', profiles),
  configPath: () => ipcRenderer.invoke('profiles:configPath'),
  getAutoLaunch: () => ipcRenderer.invoke('settings:getAutoLaunch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('settings:setAutoLaunch', enabled),
  startTunnel: (profile) => ipcRenderer.invoke('tunnel:start', profile),
  stopTunnel: (profileId) => ipcRenderer.invoke('tunnel:stop', profileId),
  tunnelStates: () => ipcRenderer.invoke('tunnel:states'),
  onTunnelStatus: (callback) => {
    ipcRenderer.on('tunnel-status', (_event, payload) => callback(payload));
  },
  onTunnelLog: (callback) => {
    ipcRenderer.on('tunnel-log', (_event, payload) => callback(payload));
  }
});
