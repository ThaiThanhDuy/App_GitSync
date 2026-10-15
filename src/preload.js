const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  auth: {
    session: call('auth:session'),
    config: call('auth:config'),
    setClientId: call('auth:setClientId'),
    deviceStart: call('auth:deviceStart'),
    deviceWait: call('auth:deviceWait'),
    deviceCancel: call('auth:deviceCancel'),
    token: call('auth:token'),
    gh: call('auth:gh'),
    logout: call('auth:logout'),
  },
  repos: {
    list: call('repos:list'),
    add: call('repos:add'),
    remove: call('repos:remove'),
    status: call('repos:status'),
    pull: call('repos:pull'),
    push: call('repos:push'),
    changes: call('repos:changes'),
    commit: call('repos:commit'),
    log: call('repos:log'),
    commitDetail: call('repos:commitDetail'),
  },
  settings: {
    get: call('settings:get'),
    setTheme: call('settings:setTheme'),
    setCheckInterval: call('settings:setCheckInterval'),
  },
  openFolder: call('shell:openFolder'),
  openUrl: call('shell:openUrl'),
});
