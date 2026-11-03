"""Deploy ClauseGuard once and record the address in the frontend.

The console talks to exactly one contract: `frontend/src/config.js` carries its
address and every visitor reads and writes that one. This script is the only
thing that deploys, it is run by the "Deploy Contract" workflow, and it rewrites
the config so the address ships with the site.

    python scripts/deploy.py            # deploy only if no address is recorded
    python scripts/deploy.py --force    # redeploy and replace the address
"""

import argparse
import re
import sys
from pathlib import Path

from genlayer_py import create_client, studionet

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from wallet import load_account  # noqa: E402

CONTRACT_PATH = ROOT / "contracts" / "ClauseGuard.py"
CONFIG_PATH = ROOT / "frontend" / "src" / "config.js"

POLL_INTERVAL = 10_000
POLL_RETRIES = 60
ADDRESS_RE = re.compile(r'CONTRACT_ADDRESS\s*=\s*"([^"]*)"')
ADDRESS_VALUE = re.compile(r"0x[0-9a-fA-F]{40}")


def recorded_address() -> str:
    match = ADDRESS_RE.search(CONFIG_PATH.read_text(encoding="utf-8"))
    return (match.group(1) if match else "").strip()


def write_address(address: str) -> None:
    source = CONFIG_PATH.read_text(encoding="utf-8")
    updated = ADDRESS_RE.sub(f'CONTRACT_ADDRESS = "{address}"', source, count=1)
    if updated == source:
        raise SystemExit("could not find CONTRACT_ADDRESS in frontend/src/config.js")
    CONFIG_PATH.write_text(updated, encoding="utf-8")


def find_address(receipt) -> str:
    if not isinstance(receipt, dict):
        return ""
    candidates = [receipt.get("to_address"), receipt.get("recipient")]
    for key in ("data", "tx_data_decoded"):
        block = receipt.get(key)
        if isinstance(block, dict):
            candidates.append(block.get("contract_address"))
            candidates.append(block.get("to_address"))
    for value in candidates:
        if isinstance(value, str) and ADDRESS_VALUE.fullmatch(value):
            return value
    return ""


def execution_succeeded(receipt) -> bool:
    if not isinstance(receipt, dict):
        return False
    if receipt.get("status_name") not in ("ACCEPTED", "FINALIZED"):
        return False
    leader = (receipt.get("consensus_data") or {}).get("leader_receipt")
    if isinstance(leader, list):
        leader = leader[0] if leader else None
    if isinstance(leader, dict):
        return leader.get("execution_result") == "SUCCESS"
    return str(receipt.get("tx_execution_result_name", "")) == "FINISHED_WITH_RETURN"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="redeploy even when an address is recorded")
    args = parser.parse_args()

    existing = recorded_address()
    if existing and not args.force:
        print(f"[deploy] config already points at {existing}; nothing to deploy")
        return 0

    account = load_account("tester1")
    client = create_client(studionet, account=account)
    code = CONTRACT_PATH.read_text(encoding="utf-8")

    print(f"[deploy] deploying from {account.address}")
    tx_hash = client.deploy_contract(code=code, account=account)
    print(f"[deploy] transaction {tx_hash}")

    receipt = client.wait_for_transaction_receipt(
        tx_hash, retries=POLL_RETRIES, interval=POLL_INTERVAL
    )
    if not execution_succeeded(receipt):
        raise SystemExit(f"[deploy] the deployment did not succeed: {receipt}")

    address = find_address(receipt)
    if not address:
        raise SystemExit(f"[deploy] no contract address in the receipt: {receipt}")

    write_address(address)
    print(f"[deploy] ClauseGuard is at {address}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
