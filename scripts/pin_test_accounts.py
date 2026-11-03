"""Rewrite gltest.config.yaml with accounts unlocked from the committed keystores.

Why this exists: gltest reads a single fixed config file, and a config that
references an unset environment variable fails before any test runs. The
committed config therefore stays env-free (so direct-mode tests and lint never
need secrets), and this script generates the studionet variant at run time.

Passwords come from the environment first (repository secrets), then from the
password files next to the keystores. Neither file is ever written into the
generated config — only the derived private keys, which stay inside the CI
runner for the length of the job.
"""

import json
import os
from pathlib import Path

from eth_account import Account

PAIRS = [
    ("tests/tester1-keystore.json", "CLAUSEGUARD_TEST1_PASSWORD", "tests/tester1.password"),
    ("tests/tester2-keystore.json", "CLAUSEGUARD_TEST2_PASSWORD", "tests/tester2.password"),
]


def _password(env_name: str, path: str) -> str:
    value = os.environ.get(env_name)
    if value and value.strip():
        return value.strip()
    return Path(path).read_text().strip()


def main() -> None:
    keys = []
    for keystore_path, env_name, password_path in PAIRS:
        keystore = json.loads(Path(keystore_path).read_text())
        password = _password(env_name, password_path)
        keys.append("0x" + Account.decrypt(keystore, password).hex())

    config = (
        "networks:\n"
        "  default: localnet\n"
        "\n"
        "  localnet:\n"
        '    url: "http://127.0.0.1:4000/api"\n'
        "\n"
        "  studionet:\n"
        "    accounts:\n"
        f'      - "{keys[0]}"\n'
        f'      - "{keys[1]}"\n'
        f'    from: "{keys[0]}"\n'
        "\n"
        "paths:\n"
        '  contracts: "contracts"\n'
        "\n"
        "environment: .env\n"
    )
    Path("gltest.config.yaml").write_text(config)

    # Addresses are public; keys are not, so only addresses are printed.
    print(
        "[clauseguard] pinned accounts: "
        f"{Account.from_key(keys[0]).address} "
        f"{Account.from_key(keys[1]).address}"
    )


if __name__ == "__main__":
    main()
