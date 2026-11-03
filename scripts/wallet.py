"""Load the tester wallets from tests/. Nothing is written anywhere.

The keystores and their passwords live in tests/ (they are committed, on
purpose: they are throwaway studionet accounts). A password in the environment
wins over the committed file, so the files can be deleted once the same value is
set as a repository secret.
"""

import json
import os
from pathlib import Path

from eth_account import Account

DEFAULT_FOLDER = Path(__file__).resolve().parents[1] / "tests"
DEFAULT_WALLET = "tester1"


def wallet_folder() -> Path:
    configured = os.environ.get("CLAUSEGUARD_WALLET_FOLDER")
    return Path(configured) if configured else DEFAULT_FOLDER


def load_account(name: str = DEFAULT_WALLET):
    """Decrypt one keystore from the wallet folder and return the account."""
    folder = wallet_folder()
    keystore_path = folder / f"{name}-keystore.json"
    password_path = folder / f"{name}.password"

    if not keystore_path.exists():
        available = sorted(
            path.name.replace("-keystore.json", "")
            for path in folder.glob("*-keystore.json")
        )
        raise SystemExit(
            f"no wallet '{name}' in {folder}\n"
            f"available there: {', '.join(available) or '(none)'}"
        )

    password = ""
    if password_path.exists():
        password = password_path.read_text(encoding="utf-8").strip()

    env_password = os.environ.get(f"CLAUSEGUARD_{name.upper()}_PASSWORD")
    if env_password:
        password = env_password

    data = json.loads(keystore_path.read_text(encoding="utf-8"))
    return Account.from_key(Account.decrypt(data, password))
