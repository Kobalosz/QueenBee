"""Start one bounded headless Claude Code run for a QueenBee agent, on any operating system.

Each agent's run.py builds its prompt and its tool limits, then calls run(). This module handles the
parts that differ between Windows, macOS and Linux:

  - a run lock (.run.lock in the agent folder) that the OS releases if a run crashes, holding the
    run's process id so the Grants app can tell a live run from a stale file;
  - finding the claude command (claude.exe, claude.cmd or claude);
  - passing the prompt on standard input, so no shell ever has to quote it;
  - UTF-8 everywhere, which Windows does not default to;
  - for scheduled runs, appending everything to logs/scheduled-run.log, then an optional post-run script.
Standard library only.
"""
import datetime
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

LOCK_NAME = ".run.lock"
_LOCK_OFFSET = 1 << 20  # lock a byte far from the pid, so readers on Windows can still read the pid


def python_command():
    """What to type to run Python in the agent's shell. Claude Code on Windows uses Git Bash, where
    python.org's installer provides `python`, not `python3`."""
    return "python" if os.name == "nt" else "python3"


def find_claude():
    home = Path.home()
    for p in (home / ".local" / "bin" / "claude.exe", home / ".local" / "bin" / "claude"):
        if p.is_file():
            return str(p)
    found = shutil.which("claude")
    if found:
        return found
    raise FileNotFoundError("Claude Code was not found. Install it from https://claude.com/claude-code and sign in.")


class RunLock:
    """An exclusive OS-level lock: a second run started while one is active skips; a crashed run's
    lock is released by the OS, so the next run proceeds."""

    def __init__(self, folder):
        self.path = Path(folder) / LOCK_NAME
        self.fd = None

    def acquire(self):
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT)
        try:
            if os.name == "nt":
                import msvcrt
                os.lseek(fd, _LOCK_OFFSET, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return False
        os.lseek(fd, 0, os.SEEK_SET)
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode("ascii"))
        self.fd = fd
        return True

    def release(self):
        if self.fd is None:
            return
        try:
            if os.name == "nt":
                import msvcrt
                os.lseek(self.fd, _LOCK_OFFSET, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
        finally:
            os.close(self.fd)
            self.fd = None
            try:
                self.path.unlink()
            except OSError:
                pass


def utf8_env():
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def run(folder, prompt, disallowed_tools=(), extra_args=(), scheduled=False, chrome=False):
    """Run claude -p in `folder` with `prompt` on stdin. Returns the exit status."""
    folder = Path(folder).resolve()
    log = None
    if scheduled:
        (folder / "logs").mkdir(exist_ok=True)
        log = open(folder / "logs" / "scheduled-run.log", "a", encoding="utf-8")
        log.write(f"\n=== Scheduled run: {datetime.datetime.now():%Y-%m-%d %H:%M:%S} ===\n")
        log.flush()
    out = log or sys.stdout
    lock = RunLock(folder)
    if not lock.acquire():
        print("Another run is active. Skipping this one.", file=out)
        return 0
    status = 1
    try:
        cmd = [find_claude(), "-p", "--no-session-persistence"]
        if chrome:
            cmd.append("--chrome")
        if disallowed_tools:
            cmd += ["--disallowedTools", *disallowed_tools]
        cmd += list(extra_args)
        r = subprocess.run(cmd, input=prompt, cwd=folder, env=utf8_env(), text=True, encoding="utf-8",
                           errors="replace", stdout=out, stderr=subprocess.STDOUT)
        status = r.returncode
    except FileNotFoundError as e:
        print(f"ERROR: {e}", file=out)
        status = 127
    finally:
        lock.release()
        print(f"=== Session exited with status {status} ===", file=out)
    if scheduled:
        hook = _post_run_script(folder)
        if hook:
            r = subprocess.run([sys.executable, hook], cwd=folder, env=utf8_env(), stdout=out, stderr=subprocess.STDOUT)
            if r.returncode:
                print("post-run script failed (not fatal)", file=out)
        log.close()
    return status


def _post_run_script(folder):
    try:
        s = json.loads((folder / "config" / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    p = (s.get("integrations") or {}).get("post_run_script") or ""
    return p if p and Path(folder, p).is_file() else None


def utf8_stdout():
    """Call first thing in any script that prints: Windows consoles default to a legacy code page and
    fail on characters such as ★ or —."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
