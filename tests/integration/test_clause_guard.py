"""Studio-mode integration tests (real consensus, real web and LLM).

These never run under plain pytest: they need a GenLayer environment and the
`gltest` runner.

    gltest tests/integration/ -v -s --network studionet
    gltest tests/integration/ -v -s --network localnet   # local Studio (Docker)

`get_contract_factory` resolves the contract from `contracts/` by name, so
"ClauseGuard" maps to contracts/ClauseGuard.py.
"""

import pytest

from gltest import get_contract_factory
from gltest.assertions import tx_execution_succeeded

pytestmark = pytest.mark.integration

POLICY_ID = "eu-payments"
RULES_URL = "https://rules.example.com/eu/payments"
GUIDANCE = "Transfers above 10000 EUR to a sanctioned counterparty are prohibited."


def _deploy():
    return get_contract_factory("ClauseGuard").deploy(args=[])


def test_summary_starts_empty(default_account):
    contract = _deploy()

    summary = contract.get_summary().call()
    assert summary["total"] == 0
    assert summary["policies"] == 0


def test_register_and_read_policy(default_account):
    contract = _deploy()

    tx = contract.register_policy(
        args=[POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE]
    ).transact()
    assert tx_execution_succeeded(tx)

    policy = contract.get_policy(args=[POLICY_ID]).call()
    assert policy["name"] == "EU payments screen"
    assert policy["source_url"] == RULES_URL
    assert policy["active"] is True
    assert policy["assessments"] == 0

    summary = contract.get_summary().call()
    assert summary["policies"] == 1


def test_insecure_source_url_is_rejected(default_account):
    contract = _deploy()

    tx = contract.register_policy(
        args=[POLICY_ID, "Bad source", "http://rules.example.com/eu", GUIDANCE]
    ).transact()
    assert not tx_execution_succeeded(tx)
