// The only bridge between the window and the rest of the app. The window gets these calls and
// nothing else: no file system, no Node.
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (arg) => ipcRenderer.invoke(channel, arg);

contextBridge.exposeInMainWorld("grants", {
  state: call("state"),
  doc: call("doc"),
  screenshot: call("screenshot"),
  answer: call("answer"),
  done: call("done"),
  upload: call("upload"),
  approve: call("approve"),
  submitted: call("submitted"),
  outcome: call("outcome"),
  reveal: call("reveal"),
  chooseFolder: call("choose-folder"),
  onChange: (callback) => ipcRenderer.on("changed", () => callback()),
});
