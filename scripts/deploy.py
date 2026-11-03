"""Deploy ClauseGuard once, record the address, and seed a starter policy.

The console talks to exactly one contract: `frontend/src/config.js` carries its
address and every visitor reads and writes that one. This script is the only
thing that deploys, it is run by the "Deploy Contract" workflow, and it rewrites
the config so the address ships with the site.

On every run it also makes sure a starter policy exists, so a visitor opening the
site finds a policy to assess against instead of an empty registry.

    python scripts/deploy.py            # deploy only if no address is recorded
    python scripts/deploy.py --force    # redeploy and replace the address
"""

import argparse
import hashlib
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
REVISION_RE = re.compile(r'CONTRACT_REVISION\s*=\s*"([^"]*)"')
ADDRESS_VALUE = re.compile(r"0x[0-9a-fA-F]{40}")

# Public, stable, text-only: validators must be able to fetch it. Same source the
# integration suite uses.
POLICY_ID = "rfc-2119"
POLICY_NAME = "Requirement keywords (RFC 2119)"
RULES_URL = "https://www.rfc-editor.org/rfc/rfc2119.txt"
GUIDANCE = (
    "A transfer is COMPLIANT when the transaction does not violate a MUST or "
    "MUST NOT requirement in the rules. Use REVIEW when the text does not decide it."
)


def recorded_address() -> str:
    match = ADDRESS_RE.search(CONFIG_PATH.read_text(encoding="utf-8"))
    return (match.group(1) if match else "").strip()


def recorded_revision() -> str:
    match = REVISION_RE.search(CONFIG_PATH.read_text(encoding="utf-8"))
    return (match.group(1) if match else "").strip()


def write_deployment(address: str, revision: str) -> None:
    source = CONFIG_PATH.read_text(encoding="utf-8")
    updated = ADDRESS_RE.sub(f'CONTRACT_ADDRESS = "{address}"', source, count=1)
    updated = REVISION_RE.sub(f'CONTRACT_REVISION = "{revision}"', updated, count=1)
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


def wait(client, tx_hash):
    return client.wait_for_transaction_receipt(
        tx_hash, retries=POLL_RETRIES, interval=POLL_INTERVAL
    )


def ensure_policy(client, account, address: str) -> None:
    """Register the starter policy once; a second run finds it and does nothing."""
    policies = client.read_contract(address, "get_policies") or {}
    if POLICY_ID in policies:
        print(f"[seed] policy '{POLICY_ID}' already registered")
        return

    print(f"[seed] registering the starter policy '{POLICY_ID}'")
    tx_hash = client.write_contract(
        address,
        "register_policy",
        args=[POLICY_ID, POLICY_NAME, RULES_URL, GUIDANCE],
        account=account,
    )
    print(f"[seed] transaction {tx_hash}")
    receipt = wait(client, tx_hash)

    # The write is non-idempotent, so judge it by the state it was meant to change.
    policies = client.read_contract(address, "get_policies") or {}
    if POLICY_ID not in policies:
        raise SystemExit(f"[seed] the policy was not registered: {receipt}")
    if not execution_succeeded(receipt):
        print(f"[seed] warning: receipt was inconclusive, but '{POLICY_ID}' is on chain")
    print(f"[seed] '{POLICY_ID}' is registered")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="redeploy even when an address is recorded")
    args = parser.parse_args()

    account = load_account("tester1")
    client = create_client(studionet, account=account)

    code = CONTRACT_PATH.read_text(encoding="utf-8")
    revision = hashlib.sha256(code.encode("utf-8")).hexdigest()[:12]

    existing = recorded_address()
    if existing and recorded_revision() == revision and not args.force:
        print(f"[deploy] config already points at {existing} at revision {revision}; reusing it")
        address = existing
    else:
        if existing:
            print(f"[deploy] the contract source changed (revision {revision}); deploying a new contract")
        print(f"[deploy] deploying from {account.address}")
        tx_hash = client.deploy_contract(code=code, account=account)
        print(f"[deploy] transaction {tx_hash}")

        receipt = wait(client, tx_hash)
        if not execution_succeeded(receipt):
            raise SystemExit(f"[deploy] the deployment did not succeed: {receipt}")

        address = find_address(receipt)
        if not address:
            raise SystemExit(f"[deploy] no contract address in the receipt: {receipt}")

        write_deployment(address, revision)
        print(f"[deploy] ClauseGuard is at {address} (revision {revision})")

    ensure_policy(client, account, address)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
