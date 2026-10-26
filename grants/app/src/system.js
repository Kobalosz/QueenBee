// What the app runs on this computer: the agents' Python scripts, and the checks that they can run
// at all. Every command is a fixed program with fixed arguments, never a shell string.
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WIN = process.platform === "win32";
// The same name the agents' prompts use (shared/launcher.py python_command): on Windows, Claude
// Code runs scripts in Git Bash, where python.org's installer provides `python`.
const PYTHON = WIN ? "python" : "python3";

// An app opened from the Finder or the Start menu does not get a terminal's PATH. Add the places
// Python and Claude Code usually live.
function env() {
  const home = os.homedir();
  const extra = WIN
    ? [path.join(home, ".local", "bin")]
    : [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const sep = WIN ? ";" : ":";
  return Object.assign({}, process.env, {
    PATH: [...extra, process.env.PATH || ""].join(sep),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  });
}

function run(cmd, args, { cwd, input, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, env: env(), timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      resolve({ code, out: String(stdout || "").trim(), err: String(stderr || "").trim(), missing: !!err && err.code === "ENOENT" });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

async function findOnPath(name) {
  const r = await run(WIN ? "where" : "which", [name], { timeout: 10000 });
  return r.code === 0 && r.out ? r.out.split(/\r?\n/)[0] : "";
}

// Can this computer run the agents? Each answer says what to do if not.
async function checks() {
  const out = {};
  const py = await run(PYTHON, ["-c", "import sys;print('%d.%d.%d' % sys.version_info[:3])"], { timeout: 20000 });
  const v = /^(\d+)\.(\d+)\.\d+$/.exec(py.out);
  out.python = v && (+v[1] > 3 || (+v[1] === 3 && +v[2] >= 9))
    ? { ok: true, detail: `Python ${py.out}` }
    : { ok: false, detail: v ? `Python ${py.out} is too old; the agents need 3.9 or newer.` : "Python isn't installed, or isn't on the PATH." };
  const home = os.homedir();
  const local = [path.join(home, ".local", "bin", "claude.exe"), path.join(home, ".local", "bin", "claude")].find((p) => fs.existsSync(p));
  const claude = local || (await findOnPath("claude"));
  out.claude = claude ? { ok: true, detail: "Claude Code is installed" } : { ok: false, detail: "Claude Code isn't installed." };
  if (WIN) {
    const git = await findOnPath("git");
    out.git = git ? { ok: true, detail: "Git for Windows is installed" } : { ok: false, detail: "Git for Windows isn't installed. Claude Code needs it on Windows." };
  }
  return out;
}

const python = (folder, args, opts) => run(PYTHON, args, Object.assign({ cwd: folder }, opts));

// Installs, replaces or removes the agent's recurring run (shared/scheduler.py).
async function schedule(folder, frequency) {
  const r = await python(folder, ["scripts/schedule.py", frequency === "manual" ? "uninstall" : "install"], { timeout: 60000 });
  return { ok: r.code === 0, detail: (r.code === 0 ? r.out : r.err || r.out).split(/\r?\n/).slice(-3).join(" ") };
}

// The mailbox password goes from the window to this process to the script's standard input, and
// from there into the system's password store. It is never written to a file or a log.
async function savePassword(resultsFolder, password) {
  let r = await python(resultsFolder, ["scripts/save_password.py"], { input: password + "\n", timeout: 30000 });
  if (r.code === 3) {
    // keyring is missing: install the email agent's one dependency, then try again.
    const req = ["-m", "pip", "install", "--disable-pip-version-check", "-r", "requirements.txt"];
    let pip = await python(resultsFolder, req, { timeout: 300000 });
    if (pip.code !== 0) pip = await python(resultsFolder, [...req, "--user"], { timeout: 300000 });
    if (pip.code !== 0) {
      return { ok: false, detail: `Couldn't install the password helper. In a terminal in the grant-results folder, run: ${PYTHON} -m pip install -r requirements.txt` };
    }
    r = await python(resultsFolder, ["scripts/save_password.py"], { input: password + "\n", timeout: 30000 });
  }
  if (r.missing) return { ok: false, detail: "Python isn't installed, so the password can't be saved yet." };
  return { ok: r.code === 0, detail: r.out || r.err };
}

// Signs in to the mailbox without reading any message (fetch_mail.py --check).
async function checkMail(resultsFolder) {
  const r = await python(resultsFolder, ["scripts/fetch_mail.py", "--check"], { timeout: 60000 });
  if (r.code === 0) {
    try {
      const s = JSON.parse(r.out.split(/\r?\n/).pop());
      if (s.status === "ok") return { ok: true, detail: "Signed in. The email helper can read this inbox." };
      return { ok: false, detail: `Signed in, but these folders weren't found: ${(s.missing_folders || []).join(", ")}.` };
    } catch {}
  }
  return { ok: false, detail: (r.err || r.out || "The sign-in check failed.").split(/\r?\n/).pop() };
}

// Starts one grant run now, in the background, exactly as the schedule would. Its output goes to
// logs/scheduled-run.log, and the window shows it running through the run lock.
function startRun(folder) {
  const child = spawn(PYTHON, ["run.py", "--scheduled"], { cwd: folder, env: env(), detached: true, stdio: "ignore", windowsHide: true });
  return new Promise((resolve) => {
    child.once("error", (e) => resolve({ ok: false, error: e.code === "ENOENT" ? "Python isn't installed, so the agent can't start." : e.message }));
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

module.exports = { checks, schedule, savePassword, checkMail, startRun, PYTHON, WIN };
