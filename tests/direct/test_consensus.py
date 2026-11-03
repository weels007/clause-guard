"""Validator consensus: what counts as agreement between leader and validator.

Direct mode captures the validator of the last run_nondet call, so these tests
swap mocks and then replay the validator against the stored leader result.
"""

import json

POLICY_ID = "eu-payments"
RULES_URL = "https://rules.example.com/eu/payments"
GUIDANCE = "Transfers above 10000 EUR to a sanctioned counterparty are prohibited."


def _mock_rules(direct_vm):
    direct_vm.mock_web(
        r".*rules\.example\.com.*",
        {"status": 200, "body": "Article 4: sanctioned transfers are prohibited."},
    )


def _mock_verdict(direct_vm, verdict, score):
    direct_vm.mock_llm(
        r".*\[\[COMPLIANCE_ASSESSMENT\]\].*",
        json.dumps({"verdict": verdict, "risk_score": score, "findings": "article 4"}),
    )


def _prepare(direct_vm, direct_deploy, direct_owner, verdict, score):
    contract = direct_deploy("contracts/ComplianceGate.py")
    direct_vm.sender = direct_owner
    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)

    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, verdict, score)
    contract.assess(POLICY_ID, "ACME GmbH", "Vendor Co", "12000 EUR", "wire")
    return contract


def test_validator_accepts_identical_result(direct_vm, direct_deploy, direct_owner):
    _prepare(direct_vm, direct_deploy, direct_owner, "NON_COMPLIANT", 80)

    assert direct_vm.run_validator() is True


def test_validator_accepts_score_inside_tolerance(
    direct_vm, direct_deploy, direct_owner
):
    _prepare(direct_vm, direct_deploy, direct_owner, "NON_COMPLIANT", 80)

    direct_vm.clear_mocks()
    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, "NON_COMPLIANT", 88)

    assert direct_vm.run_validator() is True


def test_validator_rejects_score_outside_tolerance(
    direct_vm, direct_deploy, direct_owner
):
    _prepare(direct_vm, direct_deploy, direct_owner, "NON_COMPLIANT", 45)

    direct_vm.clear_mocks()
    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, "NON_COMPLIANT", 95)

    assert direct_vm.run_validator() is False


def test_validator_rejects_different_verdict(
    direct_vm, direct_deploy, direct_owner
):
    _prepare(direct_vm, direct_deploy, direct_owner, "COMPLIANT", 10)

    direct_vm.clear_mocks()
    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, "NON_COMPLIANT", 10)

    assert direct_vm.run_validator() is False


def test_validator_rejects_different_risk_band(
    direct_vm, direct_deploy, direct_owner
):
    _prepare(direct_vm, direct_deploy, direct_owner, "COMPLIANT", 20)

    direct_vm.clear_mocks()
    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, "COMPLIANT", 70)

    assert direct_vm.run_validator() is False
