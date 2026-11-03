"""Aggregate views: registry listing, assessment list, counters."""

import json

POLICY_ID = "eu-payments"
RULES_URL = "https://rules.example.com/eu/payments"
GUIDANCE = "Transfers above 10000 EUR to a sanctioned counterparty are prohibited."


def _mock(direct_vm, verdict, score):
    direct_vm.mock_web(
        r".*rules\.example\.com.*",
        {"status": 200, "body": "Article 4: sanctioned transfers are prohibited."},
    )
    direct_vm.mock_llm(
        r".*\[\[COMPLIANCE_ASSESSMENT\]\].*",
        json.dumps({"verdict": verdict, "risk_score": score, "findings": "see article 4"}),
    )


def test_empty_contract(direct_deploy):
    contract = direct_deploy("contracts/ClauseGuard.py")

    assert contract.get_policies() == {}
    assert contract.get_assessments() == {}
    assert contract.get_assessment_ids()["ids"] == []

    summary = contract.get_summary()
    assert summary["total"] == 0
    assert summary["policies"] == 0
    assert summary["high_risk"] == 0


def test_policies_are_listed(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)
    contract.register_policy(
        "us-ofac", "OFAC screen", "https://rules.example.com/us/ofac", "OFAC list."
    )

    policies = contract.get_policies()
    assert len(policies) == 2
    assert POLICY_ID in policies
    assert "us-ofac" in policies
    assert policies[POLICY_ID]["name"] == "EU payments screen"


def test_summary_counts_verdicts(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner
    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)

    _mock(direct_vm, "COMPLIANT", 5)
    contract.assess(POLICY_ID, "A", "B", "100 EUR", "first")

    direct_vm.clear_mocks()
    _mock(direct_vm, "NON_COMPLIANT", 90)
    contract.assess(POLICY_ID, "A", "C", "200 EUR", "second")

    direct_vm.clear_mocks()
    _mock(direct_vm, "REVIEW", 50)
    contract.assess(POLICY_ID, "A", "D", "300 EUR", "third")

    summary = contract.get_summary()
    assert summary["total"] == 3
    assert summary["compliant"] == 1
    assert summary["non_compliant"] == 1
    assert summary["review"] == 1
    assert summary["high_risk"] == 1
    assert summary["policies"] == 1


def test_unknown_assessment_view_reverts(direct_vm, direct_deploy):
    contract = direct_deploy("contracts/ClauseGuard.py")

    with direct_vm.expect_revert("[EXPECTED]:unknown_assessment"):
        contract.get_assessment("ca-99")
