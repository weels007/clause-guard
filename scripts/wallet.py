"""Load the tester wallets, from tests/ or from the environment.

Local runs read `tests/<name>-keystore.json` and `tests/<name>.password`. CI can
instead provide `CLAUSEGUARD_<NAME>_KEYSTORE` (the keystore JSON, raw or base64)
and `CLAUSEGUARD_<NAME>_PASSWORD`, so no key material lives in the repository.
An environment password wins over the file.
"""

import base64
import json
import os
from pathlib import Path

from eth_account import Account

DEFAULT_FOLDER = Path(__file__).resolve().parents[1] / "tests"
DEFAULT_WALLET = "tester1"


def wallet_folder() -> Path:
    configured = os.environ.get("CLAUSEGUARD_WALLET_FOLDER")
    return Path(configured) if configured else DEFAULT_FOLDER


def _keystore_from_env(name: str):
    raw = os.environ.get(f"CLAUSEGUARD_{name.upper()}_KEYSTORE", "").strip()
    if not raw:
        return None
    payload = raw
    if not raw.lstrip().startswith("{"):
        try:
            payload = base64.b64decode(raw).decode("utf-8")
        except Exception as error:
            raise SystemExit(
                f"[wallet] {name}: CLAUSEGUARD_{name.upper()}_KEYSTORE is neither JSON nor base64"
            ) from error
    try:
        return json.loads(payload)
    except Exception as error:
        raise SystemExit(
            f"[wallet] {name}: CLAUSEGUARD_{name.upper()}_KEYSTORE is not a keystore"
        ) from error


def load_account(name: str = DEFAULT_WALLET):
    """Decrypt one keystore (file or environment) and return the account."""
    folder = wallet_folder()
    keystore_path = folder / f"{name}-keystore.json"
    password_path = folder / f"{name}.password"

    password = ""
    if password_path.exists():
        password = password_path.read_text(encoding="utf-8").strip()

    env_password = os.environ.get(f"CLAUSEGUARD_{name.upper()}_PASSWORD")
    if env_password:
        password = env_password

    data = None
    if keystore_path.exists():
        data = json.loads(keystore_path.read_text(encoding="utf-8"))
    else:
        data = _keystore_from_env(name)

    if data is None:
        available = sorted(
            path.name.replace("-keystore.json", "")
            for path in folder.glob("*-keystore.json")
        )
        raise SystemExit(
            f"no wallet '{name}' in {folder} and no CLAUSEGUARD_{name.upper()}_KEYSTORE\n"
            f"available there: {', '.join(available) or '(none)'}"
        )

    if not password:
        raise SystemExit(
            f"[wallet] {name}: no password (tests/{name}.password or "
            f"CLAUSEGUARD_{name.upper()}_PASSWORD)"
        )

    return Account.from_key(Account.decrypt(data, password))
