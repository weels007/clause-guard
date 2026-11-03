"""Policy registry: ownership, validation, activation, locking."""

import json

POLICY_ID = "eu-payments"
RULES_URL = "https://rules.example.com/eu/payments"
GUIDANCE = "Transfers above 10000 EUR to a sanctioned counterparty are prohibited."
QUOTE = "sanctioned transfers are prohibited"


def test_owner_can_register_policy(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    contract.register_policy(
        POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE
    )

    policy = contract.get_policy(POLICY_ID)
    assert policy["name"] == "EU payments screen"
    assert policy["source_url"] == RULES_URL
    assert policy["guidance"] == GUIDANCE
    assert policy["active"] is True
    assert policy["assessments"] == 0
    assert policy["version"] == 1


def test_owner_can_update_policy_before_use(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)
    contract.update_policy(
        POLICY_ID,
        "EU payments screen v2",
        "https://rules.example.com/eu/payments-v2",
        "Updated guidance.",
    )

    policy = contract.get_policy(POLICY_ID)
    assert policy["name"] == "EU payments screen v2"
    assert policy["source_url"] == "https://rules.example.com/eu/payments-v2"
    assert policy["guidance"] == "Updated guidance."
    assert policy["version"] == 2


def test_policy_is_locked_after_first_assessment(
    direct_vm, direct_deploy, direct_owner
):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner
    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)

    direct_vm.mock_web(
        r".*rules\.example\.com.*",
        {"status": 200, "body": "Article 4: sanctioned transfers are prohibited."},
    )
    direct_vm.mock_llm(
        r".*\[\[COMPLIANCE_ASSESSMENT\]\].*",
        json.dumps(
            {
                "verdict": "COMPLIANT",
                "risk_level": "LOW",
                "rule_quote": QUOTE,
                "findings": "article 4",
            }
        ),
    )
    contract.assess(POLICY_ID, "A", "B", "100 EUR", "context", "ref-1")

    with direct_vm.expect_revert("[EXPECTED]:policy_locked"):
        contract.update_policy(
            POLICY_ID,
            "New name",
            "https://rules.example.com/other",
            "Other guidance.",
        )


def test_policy_id_is_normalised(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    contract.register_policy("EU-Payments", "EU payments screen", RULES_URL, GUIDANCE)

    assert contract.get_policy("eu-payments")["name"] == "EU payments screen"


def test_duplicate_policy_reverts(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)

    with direct_vm.expect_revert("[EXPECTED]:policy_exists"):
        contract.register_policy(POLICY_ID, "duplicate", RULES_URL, GUIDANCE)


def test_non_owner_cannot_register(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert("[EXPECTED]:unauthorized"):
        contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)


def test_non_owner_cannot_deactivate(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert("[EXPECTED]:unauthorized"):
        contract.set_policy_active(POLICY_ID, False)


def test_insecure_source_url_reverts(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("[EXPECTED]:invalid_source_url"):
        contract.register_policy(
            POLICY_ID, "EU payments screen", "http://rules.example.com/eu", GUIDANCE
        )


def test_empty_guidance_reverts(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("[EXPECTED]:empty_guidance"):
        contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, "   ")


def test_invalid_policy_id_reverts(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("[EXPECTED]:invalid_policy_id"):
        contract.register_policy(
            "eu payments/../../etc", "EU payments screen", RULES_URL, GUIDANCE
        )


def test_policy_can_be_deactivated(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)
    contract.set_policy_active(POLICY_ID, False)

    assert contract.get_policy(POLICY_ID)["active"] is False


def test_unknown_policy_view_reverts(direct_vm, direct_deploy):
    contract = direct_deploy("contracts/ClauseGuard.py")

    with direct_vm.expect_revert("[EXPECTED]:unknown_policy"):
        contract.get_policy("does-not-exist")


def test_owner_is_recorded(direct_vm, direct_deploy):
    contract = direct_deploy("contracts/ClauseGuard.py")
    owner = contract.get_owner()
    assert owner.startswith("0x")
    assert len(owner) == 42
