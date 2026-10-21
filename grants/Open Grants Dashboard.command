#!/bin/bash
# Double-click in Finder to open the grants dashboard in the browser.
# Keep the window that opens; closing it stops the dashboard.
cd "$(dirname "$0")" || exit 1
exec /usr/bin/env python3 scripts/dashboard.py --open
