// Preload for the hidden background-removal window (main/bgRemovalWindow.js).
// Two calls only: take a job, send progress / the result back.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bgWorker', {
  onJob: (cb) => ipcRenderer.on('bg:job', (_event, job) => cb(job)),
  send: (msg) => ipcRenderer.send('bg:from-worker', msg),
});
