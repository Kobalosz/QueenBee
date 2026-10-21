"""Install, remove and report the recurring run for one QueenBee agent, on any operating system.

    Windows  Task Scheduler (schtasks), runs only while the owner is signed in, because the agents
             drive the owner's own Chrome.
    macOS    a launchd agent in ~/Library/LaunchAgents.
    Linux    a crontab line.

Every agent folder gets its own task, named from the agent and a hash of the folder's path, so two
clones (one per client, say) never overwrite each other. The task runs `<python> run.py --scheduled`
in the agent's folder. Standard library only.
"""
import hashlib
import os
import platform
import re
import subprocess
import sys
from pathlib import Path

FREQUENCIES = ("manual", "daily", "weekdays", "twice-weekly", "weekly")
# Day codes per frequency: schtasks names, launchd/cron numbers (Sunday = 0).
_DAYS = {
    "daily": (None, None),
    "weekdays": ("MON,TUE,WED,THU,FRI", (1, 2, 3, 4, 5)),
    "twice-weekly": ("MON,THU", (1, 4)),
    "weekly": ("MON", (1,)),
}


class Job:
    def __init__(self, agent, folder, python=None):
        self.agent = agent
        self.folder = Path(folder).resolve()
        self.python = python or sys.executable
        digest = hashlib.sha1(str(self.folder).encode("utf-8")).hexdigest()[:8]
        self.task_name = f"QueenBee\\{agent}-{digest}"
        self.label = f"com.queenbee.{agent}.{digest}"
        self.cron_tag = f"# queenbee-{agent}:{digest}"
        self.plist = Path.home() / "Library" / "LaunchAgents" / f"{self.label}.plist"
        self.system = platform.system()

    # ── install ───────────────────────────────────────────────────────────────────
    def install(self, frequency, hour=9):
        if frequency == "manual":
            return "schedule.frequency is 'manual'. Set it in config/settings.json first."
        if frequency not in _DAYS:
            raise ValueError(f"Unknown frequency {frequency!r}; use one of {', '.join(FREQUENCIES)}")
        hour = int(hour)
        if not 0 <= hour <= 23:
            raise ValueError("schedule.hour must be 0-23")
        (self.folder / "logs").mkdir(exist_ok=True)
        if self.system == "Windows":
            return self._install_windows(frequency, hour)
        if self.system == "Darwin":
            return self._install_launchd(frequency, hour)
        return self._install_cron(frequency, hour)

    def windows_command(self, frequency, hour, wrapper):
        """The schtasks arguments, separate so they can be checked without Windows."""
        days, _ = _DAYS[frequency]
        cmd = ["schtasks", "/Create", "/F", "/TN", self.task_name, "/TR", f'"{wrapper}"', "/ST", f"{hour:02d}:00"]
        cmd += ["/SC", "DAILY"] if days is None else ["/SC", "WEEKLY", "/D", days]
        return cmd

    def windows_wrapper(self):
        """A tiny .cmd in the agent's state folder. It keeps the task's command short (schtasks
        caps it at 261 characters) and starts in the right folder."""
        return f'@echo off\r\ncd /d "{self.folder}"\r\n"{self.python}" run.py --scheduled\r\n'

    def _install_windows(self, frequency, hour):
        state = self.folder / "state"
        state.mkdir(exist_ok=True)
        wrapper = state / "scheduled_run.cmd"
        wrapper.write_text(self.windows_wrapper(), encoding="utf-8")
        r = subprocess.run(self.windows_command(frequency, hour, wrapper), capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout).strip() or "schtasks failed")
        return (f"Installed Task Scheduler task '{self.task_name}' ({frequency} at {hour:02d}:00).\n"
                f"  It runs only while you are signed in to Windows, with Chrome available.\n"
                f"  log: {self.folder / 'logs' / 'scheduled-run.log'}")

    def launchd_plist(self, frequency, hour):
        _, days = _DAYS[frequency]
        entry = lambda d: (f"<dict>{'' if d is None else f'<key>Weekday</key><integer>{d}</integer>'}"
                           f"<key>Hour</key><integer>{hour}</integer><key>Minute</key><integer>0</integer></dict>")
        cal = entry(None) if days is None else "<array>" + "".join(entry(d) for d in days) + "</array>"
        esc = lambda s: str(s).replace("&", "&amp;").replace("<", "&lt;")
        return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{self.label}</string>
  <key>ProgramArguments</key>
  <array><string>{esc(self.python)}</string><string>{esc(self.folder / 'run.py')}</string><string>--scheduled</string></array>
  <key>WorkingDirectory</key><string>{esc(self.folder)}</string>
  <key>StartCalendarInterval</key>{cal}
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>{esc(self.folder / 'logs' / 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>{esc(self.folder / 'logs' / 'launchd.err.log')}</string>
</dict>
</plist>
"""

    def _install_launchd(self, frequency, hour):
        self.plist.parent.mkdir(parents=True, exist_ok=True)
        self.plist.write_text(self.launchd_plist(frequency, hour), encoding="utf-8")
        subprocess.run(["launchctl", "unload", str(self.plist)], capture_output=True)
        r = subprocess.run(["launchctl", "load", str(self.plist)], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip() or "launchctl load failed")
        msg = f"Installed launchd job '{self.label}' ({frequency} at {hour:02d}:00)."
        home = Path.home()
        if any(str(self.folder).startswith(str(home / d)) for d in ("Desktop", "Documents", "Downloads")):
            msg += ("\n  NOTE: macOS blocks background jobs from reading Desktop, Documents and Downloads. Move the"
                    "\n  QueenBee folder elsewhere (e.g. ~/QueenBee), or grant Full Disk Access to the Python above.")
        return msg

    def cron_line(self, frequency, hour):
        _, days = _DAYS[frequency]
        dow = "*" if days is None else ",".join(str(d) for d in days)
        return f'0 {hour} * * {dow} cd "{self.folder}" && "{self.python}" run.py --scheduled {self.cron_tag}'

    def _install_cron(self, frequency, hour):
        lines = [l for l in self._crontab() if self.cron_tag not in l] + [self.cron_line(frequency, hour)]
        subprocess.run(["crontab", "-"], input="\n".join(lines) + "\n", text=True, check=True)
        return f"Installed cron entry ({frequency} at {hour:02d}:00)."

    def _crontab(self):
        r = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
        return r.stdout.splitlines() if r.returncode == 0 else []

    # ── uninstall / status ────────────────────────────────────────────────────────
    def uninstall(self):
        if self.system == "Windows":
            r = subprocess.run(["schtasks", "/Delete", "/F", "/TN", self.task_name], capture_output=True, text=True)
            return f"Removed task '{self.task_name}'." if r.returncode == 0 else "Nothing scheduled for this folder."
        if self.system == "Darwin":
            if self.plist.exists():
                subprocess.run(["launchctl", "unload", str(self.plist)], capture_output=True)
                self.plist.unlink()
                return f"Removed launchd job '{self.label}'."
            return "Nothing scheduled for this folder."
        lines = self._crontab()
        if not any(self.cron_tag in l for l in lines):
            return "Nothing scheduled for this folder."
        subprocess.run(["crontab", "-"], input="\n".join(l for l in lines if self.cron_tag not in l) + "\n", text=True, check=True)
        return "Removed cron entry."

    def status(self):
        out = [f"Folder: {self.folder}", f"Python: {self.python}"]
        if self.system == "Windows":
            r = subprocess.run(["schtasks", "/Query", "/TN", self.task_name, "/FO", "LIST"], capture_output=True, text=True)
            if r.returncode != 0:
                out.append("Task Scheduler: not installed for this folder")
            else:
                keep = re.compile(r"^(TaskName|Next Run Time|Status|Last Run Time|Last Result):", re.I)
                out += ["Task Scheduler:"] + ["  " + l.strip() for l in r.stdout.splitlines() if keep.match(l.strip())]
        elif self.system == "Darwin":
            out.append(f"launchd: {'installed (' + str(self.plist) + ')' if self.plist.exists() else 'not installed for this folder'}")
        else:
            line = next((l for l in self._crontab() if self.cron_tag in l), None)
            out.append(f"cron: {line or 'not installed for this folder'}")
        return "\n".join(out)


def main(agent, folder, settings):
    """Shared command line for each agent's scripts/schedule.py: install | uninstall | status."""
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    sched = settings.get("schedule", {})
    job = Job(agent, folder)
    try:
        if action == "install":
            print(job.install(sched.get("frequency", "manual"), sched.get("hour", 9)))
        elif action == "uninstall":
            print(job.uninstall())
        elif action == "status":
            print(f"Frequency: {sched.get('frequency', 'manual')} at {int(sched.get('hour', 9)):02d}:00")
            print(job.status())
        else:
            sys.exit("Usage: schedule.py [install|uninstall|status]")
    except (RuntimeError, ValueError, OSError, subprocess.CalledProcessError) as e:
        sys.exit(f"Could not {action} the schedule: {e}")
