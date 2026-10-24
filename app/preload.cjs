/**
 * The only bridge between the page and Node: `window.desk`.
 * Every call returns the handler's value or throws its error message.
 *
 * @author Patrick Finazzo
 */

const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => async (payload) => {
  const res = await ipcRenderer.invoke(`desk:${name}`, payload);
  if (!res.ok) throw new Error(res.error);
  return res.value;
};

const subscribe = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('desk', {
  openRepo: call('openRepo'),
  recents: call('recents'),
  getBoard: call('getBoard'),
  onBoard: subscribe('desk:board'),
  connect: call('connect'),
  testConnection: call('testConnection'),
  startPropose: call('startPropose'),
  startImplement: call('startImplement'),
  onRunUpdate: subscribe('desk:run'),
  acceptRisk: call('acceptRisk'),
  copyPrompt: call('copyPrompt'),
  runClaimcheck: call('runClaimcheck'),
  openPullRequest: call('openPullRequest'),
  openPath: call('openPath'),
  getRun: call('getRun'),
  ghReady: call('ghReady'),
  rendered: () => ipcRenderer.send('desk:rendered'),
});
