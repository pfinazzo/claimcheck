/**
 * The only bridge between the page and Node: `window.desk`.
 * Every call returns the handler's value or throws its error message
 * (with `code` and `details` when the handler gave them).
 *
 * @author Patrick Finazzo
 */

const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => async (payload) => {
  const res = await ipcRenderer.invoke(`desk:${name}`, payload);
  if (!res.ok) {
    const error = new Error(res.error);
    if (res.code) error.code = res.code;
    if (res.details) error.details = res.details;
    throw error;
  }
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
  getView: call('getView'),
  onBoard: subscribe('desk:board'),
  onView: subscribe('desk:view'),
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
  trustRepo: call('trustRepo'),
  getRun: call('getRun'),
  ghReady: call('ghReady'),
  wizardLoad: call('wizardLoad'),
  wizardSave: call('wizardSave'),
  wizardStart: call('wizardStart'),
  wizardStatus: call('wizardStatus'),
  wizardInit: call('wizardInit'),
  wizardSaveTestCmd: call('wizardSaveTestCmd'),
  wizardDraft: call('wizardDraft'),
  wizardFinish: call('wizardFinish'),
  wizardCancel: call('wizardCancel'),
  wizardSpec: call('wizardSpec'),
  wizardExit: call('wizardExit'),
  rendered: () => ipcRenderer.send('desk:rendered'),
});
