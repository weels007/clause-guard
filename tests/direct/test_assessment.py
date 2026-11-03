"""Assessment flow: rule fetch + LLM verdict + validator consensus."""

import json

POLICY_ID = "eu-payments"
RULES_URL = "https://rules.example.com/eu/payments"
GUIDANCE = "Transfers above 10000 EUR to a sanctioned counterparty are prohibited."

RULES_BODY = (
    "Article 4. Transfers above 10000 EUR to a sanctioned counterparty are "
    "prohibited. Transfers below that threshold are allowed when the "
    "counterparty is not on the sanctions list."
)


def _mock_rules(direct_vm, body=RULES_BODY):
    direct_vm.mock_web(r".*rules\.example\.com.*", {"status": 200, "body": body})


def _mock_verdict(direct_vm, verdict, score, findings="Article 4 applies."):
    direct_vm.mock_llm(
        r".*\[\[COMPLIANCE_ASSESSMENT\]\].*",
        json.dumps(
            {"verdict": verdict, "risk_score": score, "findings": findings}
        ),
    )


def _setup(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner
    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)
    return contract


def test_compliant_transaction_is_stored(
    direct_vm, direct_deploy, direct_owner
):
    contract = _setup(direct_vm, direct_deploy, direct_owner)
    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, "COMPLIANT", 12)

    assessment_id = contract.assess(
        POLICY_ID, "ACME GmbH", "Acme Supplier GmbH", "4200 EUR", "Monthly SaaS invoice"
    )

    assert assessment_id == "ca-1"

    record = contract.get_assessment(assessment_id)
    assert record["assessment_id"] == "ca-1"
    assert record["policy_id"] == POLICY_ID
    assert record["subject"] == "ACME GmbH"
    assert record["counterparty"] == "Acme Supplier GmbH"
    assert record["amount"] == "4200 EUR"
    assert record["verdict"] == "COMPLIANT"
    assert record["risk_score"] == 12
    assert record["risk_band"] == "LOW"

    assert contract.get_policy(POLICY_ID)["assessments"] == 1


def test_non_compliant_transaction_is_high_risk(
    direct_vm, direct_deploy, direct_owner
):
    contract = _setup(direct_vm, direct_deploy, direct_owner)
    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, "NON_COMPLIANT", 92)

    assessment_id = contract.assess(
        POLICY_ID, "ACME GmbH", "Sanctioned Trading LLC", "250000 EUR", "Wire transfer"
    )

    record = contract.get_assessment(assessment_id)
    assert record["verdict"] == "NON_COMPLIANT"
    assert record["risk_score"] == 92
    assert record["risk_band"] == "HIGH"


def test_ambiguous_case_is_sent_to_review(
    direct_vm, direct_deploy, direct_owner
):
    contract = _setup(direct_vm, direct_deploy, direct_owner)
    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, "MANUAL_REVIEW", 55)

    assessment_id = contract.assess(
        POLICY_ID, "ACME GmbH", "New Vendor Ltd", "9800 EUR", "First-time vendor"
    )

    record = contract.get_assessment(assessment_id)
    assert record["verdict"] == "REVIEW"
    assert record["risk_band"] == "MEDIUM"


def test_risk_score_is_clamped(direct_vm, direct_deploy, direct_owner):
    contract = _setup(direct_vm, direct_deploy, direct_owner)
    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, "NON_COMPLIANT", 400)

    assessment_id = contract.assess(
        POLICY_ID, "ACME GmbH", "Sanctioned Trading LLC", "1 EUR", "Probe"
    )

    assert contract.get_assessment(assessment_id)["risk_score"] == 100


def test_assessment_ids_increment(direct_vm, direct_deploy, direct_owner):
    contract = _setup(direct_vm, direct_deploy, direct_owner)
    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, "COMPLIANT", 10)

    first = contract.assess(POLICY_ID, "A", "B", "100 EUR", "first")
    second = contract.assess(POLICY_ID, "A", "B", "200 EUR", "second")

    assert first == "ca-1"
    assert second == "ca-2"
    assert contract.get_assessment_ids()["ids"] == ["ca-1", "ca-2"]
    assert contract.get_policy(POLICY_ID)["assessments"] == 2


def test_assessment_on_unknown_policy_reverts(
    direct_vm, direct_deploy, direct_owner
):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("[EXPECTED]:unknown_policy"):
        contract.assess("nope", "A", "B", "100 EUR", "context")


def test_assessment_on_inactive_policy_reverts(
    direct_vm, direct_deploy, direct_owner
):
    contract = _setup(direct_vm, direct_deploy, direct_owner)
    direct_vm.sender = direct_owner
    contract.set_policy_active(POLICY_ID, False)

    with direct_vm.expect_revert("[EXPECTED]:policy_inactive"):
        contract.assess(POLICY_ID, "A", "B", "100 EUR", "context")


def test_empty_rules_page_reverts(direct_vm, direct_deploy, direct_owner):
    contract = _setup(direct_vm, direct_deploy, direct_owner)
    _mock_rules(direct_vm, body="")
    _mock_verdict(direct_vm, "COMPLIANT", 10)

    with direct_vm.expect_revert("[EXTERNAL]:empty_rules_page"):
        contract.assess(POLICY_ID, "A", "B", "100 EUR", "context")


def test_any_account_can_request_assessment(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    contract = _setup(direct_vm, direct_deploy, direct_owner)
    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, "COMPLIANT", 20)

    direct_vm.sender = direct_alice
    assessment_id = contract.assess(
        POLICY_ID, "Alice Trading", "Vendor Co", "500 EUR", "Subscription"
    )

    record = contract.get_assessment(assessment_id)
    assert record["verdict"] == "COMPLIANT"
    assert record["requester"].startswith("0x")
