#!/usr/bin/env python3
"""Install, remove or show the recurring grant run.

    python scripts/schedule.py install     reads schedule.frequency and schedule.hour from config/settings.json
    python scripts/schedule.py status
    python scripts/schedule.py uninstall

Windows uses Task Scheduler, macOS launchd, Linux cron (see shared/scheduler.py).
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE.parent / "shared"))
import scheduler  # noqa: E402
from launcher import utf8_stdout  # noqa: E402

if __name__ == "__main__":
    utf8_stdout()
    try:
        settings = json.loads((HERE / "config" / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        sys.exit("config/settings.json is missing or unreadable. Run setup first.")
    scheduler.main("grants", HERE, settings)
