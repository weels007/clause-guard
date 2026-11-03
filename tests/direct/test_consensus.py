"""Validator consensus: what counts as agreement between leader and validator.

Direct mode captures the validator of the last run_nondet call, so these tests
swap mocks and then replay the validator against the stored leader result.

Consensus binds the two coarse decision fields only — the verdict and the risk
level. Two independent models rarely agree on an integer score, and the
equivalence-principle docs recommend comparing just the fields that matter.
"""

import json

POLICY_ID = "eu-payments"
RULES_URL = "https://rules.example.com/eu/payments"
GUIDANCE = "Transfers above 10000 EUR to a sanctioned counterparty are prohibited."
QUOTE = "sanctioned transfers are prohibited"


def _mock_rules(direct_vm):
    direct_vm.mock_web(
        r".*rules\.example\.com.*",
        {"status": 200, "body": "Article 4: sanctioned transfers are prohibited."},
    )


def _level(score):
    if score >= 67:
        return "HIGH"
    if score >= 34:
        return "MEDIUM"
    return "LOW"


def _mock_verdict(direct_vm, verdict, score):
    direct_vm.mock_llm(
        r".*\[\[COMPLIANCE_ASSESSMENT\]\].*",
        json.dumps(
            {
                "verdict": verdict,
                "risk_level": _level(score),
                "rule_quote": QUOTE,
                "findings": "article 4",
            }
        ),
    )


def _prepare(direct_vm, direct_deploy, direct_owner, verdict, score):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner
    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)

    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, verdict, score)
    contract.assess(POLICY_ID, "ACME GmbH", "Vendor Co", "12000 EUR", "wire", "ref-1")
    return contract


def test_validator_accepts_identical_result(direct_vm, direct_deploy, direct_owner):
    _prepare(direct_vm, direct_deploy, direct_owner, "NON_COMPLIANT", 80)

    assert direct_vm.run_validator() is True


def test_validator_accepts_same_level_from_different_raw_scores(
    direct_vm, direct_deploy, direct_owner
):
    # 82 and 84 are both HIGH, so they agree on the level consensus binds.
    _prepare(direct_vm, direct_deploy, direct_owner, "NON_COMPLIANT", 82)

    direct_vm.clear_mocks()
    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, "NON_COMPLIANT", 84)

    assert direct_vm.run_validator() is True


def test_validator_accepts_same_level_across_the_band(
    direct_vm, direct_deploy, direct_owner
):
    # 45 and 62 are both MEDIUM. The level is what is compared, so the stored
    # score (derived from the level) cannot drift between runs either.
    _prepare(direct_vm, direct_deploy, direct_owner, "REVIEW", 45)

    direct_vm.clear_mocks()
    _mock_rules(direct_vm)
    _mock_verdict(direct_vm, "REVIEW", 62)

    assert direct_vm.run_validator() is True


def test_validator_rejects_different_bucket(
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
