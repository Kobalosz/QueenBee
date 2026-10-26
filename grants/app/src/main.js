// The Grants app: one window onto the grant agent's folder.
//
// There is no server and no network port. The window asks this process for data over Electron's
// IPC, this process reads and writes the grants folder directly (src/store.js), and it watches that
// folder so the window updates the moment the agent writes something.
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const { Store, isGrantsFolder, runActive, now, MAX_ANSWER } = require("./store");
const { createDemoRoot } = require("./demo");
const Setup = require("./setup");
const System = require("./system");

const DEMO = process.argv.includes("--demo");
// With --demo, --setup starts the sample version at the beginning of setup instead of on sample data.
const DEMO_SETUP = DEMO && process.argv.includes("--setup");
const RENDERER = path.join(__dirname, "renderer", "index.html");
const UPLOAD_TYPES = ["pdf", "doc", "docx", "xls", "xlsx", "csv", "png", "jpg", "jpeg", "txt"];

let win = null;
let store = null;
let watcher = null;
let demoRoot = null;

app.setName("Grants");
if (process.platform === "win32") app.setAppUserModelId("com.queenbee.grants");
// One window onto the real folder at a time; sample-data windows may run beside it.
if (!DEMO && !app.requestSingleInstanceLock()) app.quit();
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
  if (DEMO) return (demoRoot = demoRoot || createDemoRoot({ blank: DEMO_SETUP }));
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
const RELEVANT = /^(applications[\\/]|config[\\/](owner-input|profile|settings)\.json|state[\\/](last_run\.json|status\.md|email-findings\.json)|\.run\.lock)/;
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

function setupStatus(root) {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(root, "config", "setup.json"), "utf8"));
  } catch {}
  return { started: !!saved, completed: !!(saved && saved.completed_at) };
}

handle("state", () => ({
  ok: true,
  state: store ? { ...store.state(), demo: DEMO, setup: setupStatus(store.root) } : { needs_folder: true, demo: DEMO },
}));

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

// A funder's email, as read by the grant-results agent. The owner's click is what makes it count.
handle("email-confirm", ({ slug, findingId, amount }) => {
  const f = store.finding(slug, findingId);
  if (!f || !store.record(slug)) return gone;
  if (f.kind === "AWARDED" || f.kind === "DECLINED") {
    let value = null;
    if (f.kind === "AWARDED" && String(amount ?? "").trim()) {
      value = Number(String(amount).replace(/[$,\s]/g, ""));
      if (!Number.isFinite(value) || value < 0) return { ok: false, error: "Write the amount as a number, like 5000." };
    }
    store.update(slug, (e) => Object.assign(e, { outcome: f.kind, outcome_amount_usd: value, outcome_at: now() }));
  }
  store.setFinding(slug, findingId, { confirmed_at: now() });
  return { ok: true, kind: f.kind };
});

handle("email-dismiss", ({ slug, findingId }) => {
  if (!store.finding(slug, findingId)) return gone;
  store.setFinding(slug, findingId, { dismissed_at: now() });
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

// ── Setup ────────────────────────────────────────────────────────────────────────
// The window sends what the owner typed; this process keeps it in config/setup.json and, once setup
// is finished, writes the agent's files from it on every explicit save.
handle("setup-get", () => {
  const d = Setup.load(store.root);
  return {
    ok: true, draft: d, review: Setup.review(d), steps: Setup.STEPS, platform: process.platform,
    results: DEMO || !!Setup.resultsFolder(store.root), demo: DEMO,
  };
});

function applySetup(d) {
  Setup.writeAgentFiles(store.root, d);
  const results = Setup.resultsFolder(store.root);
  if (results && d.mail.enabled === "yes" && d.mail.address) Setup.writeResultsSettings(results, store.root, d);
}

handle("setup-save", ({ draft, apply }) => {
  const d = Setup.normalize(draft, Setup.load(store.root));
  Setup.save(store.root, d);
  if (apply && d.completed_at) applySetup(d);
  return { ok: true, review: Setup.review(d), saved_at: d.updated_at };
});

const IMAGE_DOCS = ["logo", "owner_headshot", "photos"];

handle("setup-upload", async ({ key }) => {
  if (!Setup.DOC_KEYS.includes(key) && key !== "photos") return { ok: false, error: "Unknown document." };
  const images = IMAGE_DOCS.includes(key);
  const pick = await dialog.showOpenDialog(win, {
    title: images ? "Choose a picture" : "Choose the file",
    buttonLabel: "Add",
    properties: key === "photos" ? ["openFile", "multiSelections"] : ["openFile"],
    filters: [images ? { name: "Pictures", extensions: ["png", "jpg", "jpeg"] } : { name: "Documents and images", extensions: UPLOAD_TYPES }],
  });
  if (pick.canceled || !pick.filePaths.length) return { ok: false, cancelled: true };
  const d = Setup.load(store.root);
  const names = [];
  for (const src of pick.filePaths.slice(0, 12)) {
    const r = store.copyDoc(key.replace(/_/g, "-"), src, images);
    if (!r.ok) return r;
    if (key === "photos") d.documents.photos = [...d.documents.photos.filter((f) => f !== r.file), r.file].slice(-12);
    else d.documents[key] = r.file;
    names.push(r.name);
  }
  Setup.save(store.root, d);
  if (d.completed_at) applySetup(d);
  return { ok: true, documents: d.documents, names };
});

handle("setup-remove-doc", ({ key, file }) => {
  const d = Setup.load(store.root);
  if (key === "photos") d.documents.photos = d.documents.photos.filter((f) => f !== file);
  else if (Setup.DOC_KEYS.includes(key)) d.documents[key] = "";
  else return { ok: false, error: "Unknown document." };
  Setup.save(store.root, d);
  if (d.completed_at) applySetup(d);
  return { ok: true, documents: d.documents };
});

handle("setup-checks", () => System.checks().then((checks) => ({ ok: true, checks })));

// The mailbox app password: typed in the window, passed straight to grant-results'
// save_password.py, kept nowhere by the app.
handle("mail-password", async ({ password }) => {
  const results = Setup.resultsFolder(store.root);
  if (!results) return { ok: false, error: "The email helper (the grant-results folder) isn't next to this grants folder." };
  if (DEMO) return { ok: false, error: "The sample version doesn't save passwords." };
  const pw = String(password || "").trim();
  if (!pw || pw.length > 200) return { ok: false, error: "Paste the app password first." };
  const d = Setup.load(store.root);
  if (!d.mail.address || d.mail.provider === "microsoft") return { ok: false, error: "Enter a Gmail, iCloud, Yahoo or other IMAP address first." };
  if (d.mail.provider === "other" && !/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(d.mail.imap_host)) {
    return { ok: false, error: "Enter the mail server's name, such as imap.example.com." };
  }
  Setup.writeResultsSettings(results, store.root, d);
  const saved = await System.savePassword(results, pw);
  if (!saved.ok) return { ok: false, error: saved.detail };
  d.mail.password_saved_at = now();
  const c = await System.checkMail(results);
  d.mail.check = c.ok ? "ok" : c.detail;
  Setup.save(store.root, d);
  return { ok: true, signed_in: c.ok, detail: c.detail, mail: d.mail };
});

handle("mail-check", async () => {
  const results = Setup.resultsFolder(store.root);
  if (!results || DEMO) return { ok: false, error: "There's no email helper to check here." };
  const d = Setup.load(store.root);
  Setup.writeResultsSettings(results, store.root, d);
  const c = await System.checkMail(results);
  d.mail.check = c.ok ? "ok" : c.detail;
  Setup.save(store.root, d);
  return { ok: true, signed_in: c.ok, detail: c.detail, mail: d.mail };
});

const FREQ_WORDS = { daily: "every day", weekdays: "every weekday", "twice-weekly": "Mondays and Thursdays", weekly: "every Monday" };
const at = (h) => new Date(2000, 0, 1, Number(h) || 0).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

// Writes the agent's files, then turns the schedules on (or off).
handle("setup-finish", async () => {
  const d = Setup.load(store.root);
  const review = Setup.review(d);
  if (review.blocking.length) return { ok: false, error: "A few things the agent can't work without are still missing.", review };
  const steps = [];
  applySetup(d);
  steps.push({ ok: true, text: "Saved your answers where the agent reads them." });
  const results = Setup.resultsFolder(store.root);
  const mailOn = !!(results && d.mail.enabled === "yes" && d.mail.password_saved_at);
  if (DEMO) {
    steps.push({ ok: true, text: "This is the sample version, so no schedule was turned on." });
  } else {
    const f = d.schedule.frequency;
    const g = await System.schedule(store.root, f);
    steps.push({
      ok: g.ok,
      text: g.ok ? (f === "manual" ? "No automatic checks. Use Check for grants now." : `The agent will look for grants ${FREQ_WORDS[f]} at ${at(d.schedule.hour)}.`)
        : "The schedule couldn't be turned on.",
      detail: g.ok ? "" : g.detail,
    });
    if (results && fs.existsSync(path.join(results, "config", "settings.json"))) {
      const mf = mailOn ? d.schedule.mail_frequency : "manual";
      const m = await System.schedule(results, mf);
      steps.push({
        ok: m.ok,
        text: m.ok ? (mf === "manual" ? "Funder emails won't be read automatically." : `It will read funder emails ${FREQ_WORDS[mf]} at ${at(d.schedule.mail_hour)}.`)
          : "The email schedule couldn't be turned on.",
        detail: m.ok ? "" : m.detail,
      });
    }
  }
  d.completed_at = d.completed_at || now();
  d.done = [...new Set([...d.done, "finish"])];
  Setup.save(store.root, d);
  notify();
  return { ok: true, steps };
});

handle("run-now", async () => {
  if (DEMO) return { ok: false, error: "The sample version can't start the agent." };
  if (runActive(path.join(store.root, ".run.lock"))) return { ok: false, error: "The agent is already working." };
  if (!fs.existsSync(path.join(store.root, "config", "profile.json"))) return { ok: false, error: "Finish setup first." };
  return System.startRun(store.root);
});

// ── Lifecycle ────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (!app.isPackaged && process.env.QB_THEME) nativeTheme.themeSource = process.env.QB_THEME; // light or dark, for snapshots
  useRoot(findRoot());
  if (DEMO) console.log(`Demo folder: ${demoRoot}`);
  createWindow();
  // Development check, never in the packaged app: QB_SNAPSHOT=out.png npm run demo renders the
  // window to a PNG after QB_SNAPSHOT_DELAY ms (default 1500), scrolled down QB_SNAPSHOT_SCROLL px, and quits.
  // QB_SNAPSHOT_SIZE=WxH sets the window size first.
  if (!app.isPackaged && process.env.QB_SNAPSHOT) {
    const size = /^(\d+)x(\d+)$/.exec(process.env.QB_SNAPSHOT_SIZE || "");
    if (size) win.setSize(Number(size[1]), Number(size[2]));
    win.webContents.once("did-finish-load", () =>
      setTimeout(async () => {
        // QB_SNAPSHOT_JS: a script to run first, such as clicks through setup (awaited if it returns a promise).
        if (process.env.QB_SNAPSHOT_JS) await win.webContents.executeJavaScript(process.env.QB_SNAPSHOT_JS);
        await win.webContents.executeJavaScript(`window.scrollTo(0, ${Number(process.env.QB_SNAPSHOT_SCROLL) || 0})`);
        await new Promise((r) => setTimeout(r, 200));
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
