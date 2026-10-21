// The Grants app: one window onto the grant agent's folder.
//
// There is no server and no network port. The window asks this process for data over Electron's
// IPC, this process reads and writes the grants folder directly (src/store.js), and it watches that
// folder so the window updates the moment the agent writes something.
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const { Store, isGrantsFolder, now, MAX_ANSWER } = require("./store");
const { createDemoRoot } = require("./demo");

const DEMO = process.argv.includes("--demo");
const RENDERER = path.join(__dirname, "renderer", "index.html");
const UPLOAD_TYPES = ["pdf", "doc", "docx", "xls", "xlsx", "csv", "png", "jpg", "jpeg", "txt"];

let win = null;
let store = null;
let watcher = null;
let demoRoot = null;

app.setName("Grants");
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// ── Which folder ─────────────────────────────────────────────────────────────────
const prefsPath = () => path.join(app.getPath("userData"), "preferences.json");

function savedRoot() {
  try {
    return JSON.parse(fs.readFileSync(prefsPath(), "utf8")).root || null;
  } catch {
    return null;
  }
}

function saveRoot(root) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(prefsPath(), JSON.stringify({ root }, null, 1));
}

function findRoot() {
  if (DEMO) return (demoRoot = demoRoot || createDemoRoot());
  const saved = savedRoot();
  if (isGrantsFolder(saved)) return saved;
  // Started from the source tree (npm start): the grants folder is two levels up.
  const dev = path.resolve(__dirname, "..", "..");
  if (!app.isPackaged && isGrantsFolder(dev)) return dev;
  return null;
}

// ── Watching ─────────────────────────────────────────────────────────────────────
// Only changes the window shows: application records and docs, the owner's input, the profile and
// settings, the run summary, and the run lock appearing or disappearing.
const RELEVANT = /^(applications[\\/]|config[\\/](owner-input|profile|settings)\.json|state[\\/](last_run\.json|status\.md)|\.run\.lock)/;
let debounce = null;

function notify() {
  if (win && !win.isDestroyed()) win.webContents.send("changed");
}

function watch(root) {
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, file) => {
      if (file && !RELEVANT.test(String(file))) return;
      clearTimeout(debounce);
      debounce = setTimeout(notify, 300);
    });
    // If watching fails, the window's one-minute refresh still keeps it current.
    watcher.on("error", () => {});
  } catch {
    watcher = null;
  }
}

function useRoot(root) {
  if (watcher) watcher.close();
  watcher = null;
  store = root ? new Store(root) : null;
  if (root) watch(root);
  notify();
}

// ── The window ───────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 880,
    minWidth: 380,
    minHeight: 520,
    title: "Grants",
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#151B17" : "#F2F3EE",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  // Funder links open in the owner's browser; the app window never navigates away from itself.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  win.on("closed", () => (win = null));
  win.loadFile(RENDERER);
}

// ── What the window may ask for ──────────────────────────────────────────────────
function fromOurWindow(event) {
  try {
    return fileURLToPath(event.senderFrame.url) === RENDERER;
  } catch {
    return false;
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, arg) => {
    if (!fromOurWindow(event)) return { ok: false, error: "Not allowed." };
    if (!store && channel !== "state" && channel !== "choose-folder") {
      return { ok: false, error: "Choose the grants folder first." };
    }
    try {
      return await fn(arg && typeof arg === "object" ? arg : {});
    } catch (e) {
      return { ok: false, error: `That didn't work: ${e.message}` };
    }
  });
}

const gone = { ok: false, error: "That application has changed since this page loaded. It has been refreshed." };

handle("state", () => ({ ok: true, state: store ? { ...store.state(), demo: DEMO } : { needs_folder: true, demo: DEMO } }));

handle("doc", ({ slug, file }) => {
  const text = store.doc(slug, file || null);
  return text === null ? { ok: false, error: "That file isn't there any more." } : { ok: true, text };
});

handle("screenshot", ({ slug }) => {
  const p = store.screenshotPath(store.record(slug));
  if (!p) return { ok: false, error: "No screenshot." };
  const type = /\.png$/i.test(p) ? "image/png" : "image/jpeg";
  return { ok: true, src: `data:${type};base64,${fs.readFileSync(p).toString("base64")}` };
});

handle("answer", ({ slug, needId, answer }) => {
  if (!store.hasNeed(slug, needId)) return gone;
  const text = String(answer || "").trim();
  if (!text) return { ok: false, error: "Write an answer first." };
  if (text.length > MAX_ANSWER) return { ok: false, error: `Keep the answer under ${MAX_ANSWER} characters.` };
  store.setNeed(slug, needId, { answer: text, answered_at: now() });
  return { ok: true };
});

handle("done", ({ slug, needId }) => {
  if (!store.hasNeed(slug, needId)) return gone;
  store.setNeed(slug, needId, { done_at: now() });
  return { ok: true };
});

handle("upload", async ({ slug, needId }) => {
  if (!store.hasNeed(slug, needId)) return gone;
  const pick = await dialog.showOpenDialog(win, {
    title: "Choose the file to upload",
    buttonLabel: "Upload",
    properties: ["openFile"],
    filters: [{ name: "Documents and images", extensions: UPLOAD_TYPES }],
  });
  if (pick.canceled || !pick.filePaths.length) return { ok: false, cancelled: true };
  return store.saveUpload(slug, needId, pick.filePaths[0]);
});

handle("approve", ({ slug }) => {
  if (!store.record(slug)) return gone;
  store.update(slug, (e) => (e.approved_at = now()));
  return { ok: true };
});

handle("submitted", ({ slug }) => {
  if (!store.record(slug)) return gone;
  store.update(slug, (e) => (e.submitted_by_owner_at = now()));
  return { ok: true };
});

handle("outcome", ({ slug, outcome, amount }) => {
  if (!store.record(slug)) return gone;
  if (!["AWARDED", "DECLINED", ""].includes(outcome)) return { ok: false, error: "Unknown result." };
  let value = null;
  if (outcome === "AWARDED" && String(amount || "").trim()) {
    value = Number(String(amount).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(value) || value < 0) return { ok: false, error: "Write the amount as a number, like 5000." };
  }
  store.update(slug, (e) => Object.assign(e, { outcome, outcome_amount_usd: value, outcome_at: outcome ? now() : "" }));
  return { ok: true };
});

handle("reveal", async ({ slug }) => {
  const dir = store.packageDir(slug);
  if (!dir) return { ok: false, error: "The files for this application aren't there any more." };
  const err = await shell.openPath(dir);
  return err ? { ok: false, error: err } : { ok: true };
});

handle("choose-folder", async () => {
  if (DEMO) return { ok: false, error: "The sample version always uses sample data." };
  const pick = await dialog.showOpenDialog(win, {
    title: "Choose the grants folder",
    buttonLabel: "Use this folder",
    properties: ["openDirectory"],
  });
  if (pick.canceled || !pick.filePaths.length) return { ok: false, cancelled: true };
  const root = pick.filePaths[0];
  if (!isGrantsFolder(root)) {
    return { ok: false, error: "That isn't the grants folder. Choose the folder named grants inside QueenBee; it has a file called CLAUDE.md in it." };
  }
  saveRoot(root);
  useRoot(root);
  return { ok: true };
});

// ── Lifecycle ────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  useRoot(findRoot());
  if (DEMO) console.log(`Demo folder: ${demoRoot}`);
  createWindow();
  // Development check, never in the packaged app: QB_SNAPSHOT=out.png npm run demo renders the
  // window to a PNG after QB_SNAPSHOT_DELAY ms (default 1500) and quits.
  if (!app.isPackaged && process.env.QB_SNAPSHOT) {
    win.webContents.once("did-finish-load", () =>
      setTimeout(async () => {
        fs.writeFileSync(process.env.QB_SNAPSHOT, (await win.webContents.capturePage()).toPNG());
        app.quit();
      }, Number(process.env.QB_SNAPSHOT_DELAY) || 1500)
    );
  }
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || DEMO) app.quit();
});

app.on("will-quit", () => {
  if (watcher) watcher.close();
  if (demoRoot) fs.rmSync(demoRoot, { recursive: true, force: true });
});
