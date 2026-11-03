"""Exercise the pinned ClauseGuard deployment with the two tester wallets.

Every write is a real transaction signed by a keystore in tests/, and its hash is
printed so the explorer trail is easy to follow. The suite in
tests/integration deploys its own throwaway contract; this script instead drives
the one the console points at, so that address shows method calls too.

    python scripts/smoke.py                # address from frontend/src/config.js
    python scripts/smoke.py 0x...          # or an explicit contract address
"""

import re
import sys
import time
from pathlib import Path

from genlayer_py import create_client, studionet

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from wallet import load_account  # noqa: E402

CONFIG_PATH = ROOT / "frontend" / "src" / "config.js"
ADDRESS_RE = re.compile(r'CONTRACT_ADDRESS\s*=\s*"([^"]*)"')

POLL_INTERVAL = 10_000
POLL_RETRIES = 60
FEE_WEI = 1000
ESCROW_WEI = 10

SEED_POLICY_ID = "rfc-2119"
RULES_URL = "https://www.rfc-editor.org/rfc/rfc2119.txt"
GUIDANCE = "A transfer is COMPLIANT unless it violates a MUST or MUST NOT requirement."


def contract_address() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1].strip()
    match = ADDRESS_RE.search(CONFIG_PATH.read_text(encoding="utf-8"))
    return (match.group(1) if match else "").strip()


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


def send(client, account, address, method, args, value=0):
    tx_hash = client.write_contract(address, method, account=account, args=args, value=value)
    print(f"[smoke] {method} tx {tx_hash}")
    receipt = client.wait_for_transaction_receipt(
        tx_hash, retries=POLL_RETRIES, interval=POLL_INTERVAL
    )
    if not execution_succeeded(receipt):
        raise SystemExit(f"[smoke] {method} failed: {receipt}")
    return receipt


def read(client, address, method, args=None):
    return client.read_contract(address, method, args=args or [])


def main() -> int:
    address = contract_address()
    if not address:
        raise SystemExit("[smoke] no contract address configured")

    owner = load_account("tester1")
    stranger = load_account("tester2")
    client = create_client(studionet, account=owner)
    stamp = int(time.time())

    print(f"[smoke] contract {address}")
    print(f"[smoke] owner    {owner.address}")
    print(f"[smoke] stranger {stranger.address}")

    # Reads first: cheap, and they show the contract is reachable.
    print(f"[smoke] get_owner           {read(client, address, 'get_owner')}")
    print(f"[smoke] get_pending_owner   {read(client, address, 'get_pending_owner')}")
    print(f"[smoke] get_policy_fee      {read(client, address, 'get_policy_fee')}")
    print(f"[smoke] get_ledger          {read(client, address, 'get_ledger')}")
    print(f"[smoke] get_balance         {read(client, address, 'get_balance')}")
    print(f"[smoke] get_summary         {read(client, address, 'get_summary')}")

    policies = read(client, address, "get_policies")
    print(f"[smoke] policies            {sorted(policies)}")

    # 1. A stranger registers a policy and pays the anti-spam fee.
    policy_id = f"smoke-{stamp}"
    send(
        client,
        stranger,
        address,
        "register_policy",
        [policy_id, "Smoke policy", RULES_URL, GUIDANCE],
        value=FEE_WEI,
    )
    print(f"[smoke] registered          {policy_id}")

    # 2. The owner runs an assessment on the seeded policy.
    submit_ref = f"smoke-{stamp}"
    send(
        client,
        owner,
        address,
        "assess",
        [SEED_POLICY_ID, "ACME GmbH", "Acme Supplier GmbH", "4200 EUR", "smoke run", submit_ref],
    )

    assessments = read(client, address, "get_assessments")
    mine = [
        record
        for record in assessments.values()
        if str(record.get("submit_ref")) == submit_ref
        and str(record.get("requester", "")).lower().replace("0x", "")
        == owner.address.lower().replace("0x", "")
    ]
    if not mine:
        raise SystemExit("[smoke] the assessment did not show up in get_assessments")
    assessment = mine[0]
    print(
        f"[smoke] assessment          {assessment['assessment_id']} "
        f"{assessment['verdict']} {assessment['risk_band']}"
    )

    # 3. A COMPLIANT verdict can back an escrow; then the funder releases it.
    if assessment["verdict"] == "COMPLIANT":
        send(
            client,
            owner,
            address,
            "create_escrow",
            [assessment["assessment_id"], stranger.address, "smoke"],
            value=ESCROW_WEI,
        )
        escrows = read(client, address, "get_escrows")
        mine_escrows = [
            escrow
            for escrow in escrows.values()
            if str(escrow.get("funder", "")).lower().replace("0x", "")
            == owner.address.lower().replace("0x", "")
        ]
        escrow_id = sorted(mine_escrows, key=lambda row: int(str(row["escrow_id"]).split("-")[-1]))[-1]["escrow_id"]
        print(f"[smoke] escrow              {escrow_id}")
        send(client, owner, address, "release_escrow", [escrow_id])
        print(f"[smoke] released            {escrow_id}")
    else:
        print("[smoke] verdict was not COMPLIANT, so no escrow is funded")

    print(f"[smoke] get_summary after   {read(client, address, 'get_summary')}")
    print("[smoke] done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
