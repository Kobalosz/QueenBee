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
  emailConfirm: call("email-confirm"),
  emailDismiss: call("email-dismiss"),
  chooseFolder: call("choose-folder"),
  setupGet: call("setup-get"),
  setupSave: call("setup-save"),
  setupUpload: call("setup-upload"),
  setupRemoveDoc: call("setup-remove-doc"),
  setupChecks: call("setup-checks"),
  setupFinish: call("setup-finish"),
  mailPassword: call("mail-password"),
  mailCheck: call("mail-check"),
  runNow: call("run-now"),
  installUpdate: call("install-update"),
  onChange: (callback) => ipcRenderer.on("changed", () => callback()),
});
