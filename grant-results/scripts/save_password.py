#!/usr/bin/env python3
"""Save the mailbox app password that the owner typed into the Grants app.

    python scripts/save_password.py     reads one line, the password, from standard input

Only the Grants app runs this: it passes what the owner typed straight to this process and keeps no
copy. The password goes into the system's password store (Windows Credential Manager, the macOS
Keychain, the Linux Secret Service) under mail.keychain_service and mail.address from
config/settings.json, the same place fetch_mail.py reads it from. The agent's tool allowlist does
not include this script.

Exit codes: 0 saved, 1 nothing to save or no address set, 3 the keyring package is missing.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


def main():
    try:
        s = json.loads((HERE / "config" / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        print("config/settings.json is missing. Fill in the email step in the Grants app first.")
        return 1
    mail = s.get("mail", {})
    if not mail.get("address"):
        print("No email address is set yet.")
        return 1
    pw = sys.stdin.readline().strip().replace(" ", "")
    if not pw:
        print("Nothing entered; nothing saved.")
        return 1
    try:
        import keyring
    except ImportError:
        print("The keyring package is missing.")
        return 3
    keyring.set_password(mail.get("keychain_service", "queenbee-grant-mail"), mail["address"], pw)
    print("Saved in this computer's password store.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
