"""Policy registry: ownership, validation, activation, locking."""

import json

POLICY_ID = "eu-payments"
RULES_URL = "https://rules.example.com/eu/payments"
GUIDANCE = "Transfers above 10000 EUR to a sanctioned counterparty are prohibited."
QUOTE = "sanctioned transfers are prohibited"
POLICY_FEE_WEI = 1000


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


def test_non_owner_must_pay_the_policy_fee(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert("[EXPECTED]:policy_fee_required"):
        contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)


def test_non_owner_registers_by_paying_the_fee(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    contract = direct_deploy("contracts/ClauseGuard.py")
    owner = contract.get_owner()

    direct_vm.sender = direct_alice
    direct_vm.value = POLICY_FEE_WEI
    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)
    direct_vm.value = 0

    policy = contract.get_policy(POLICY_ID)
    assert policy["creator"] != owner
    assert policy["fee_paid"] == POLICY_FEE_WEI
    assert contract.get_policy_fee()["pending"] == POLICY_FEE_WEI


def test_fee_can_be_overpaid_and_the_owner_withdraws_it(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob
):
    contract = direct_deploy("contracts/ClauseGuard.py")

    direct_vm.sender = direct_alice
    direct_vm.value = POLICY_FEE_WEI * 2
    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)
    direct_vm.value = 0

    assert contract.get_policy(POLICY_ID)["fee_paid"] == POLICY_FEE_WEI * 2
    assert contract.get_policy_fee()["pending"] == POLICY_FEE_WEI * 2

    # Anyone else cannot take the fees out.
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("[EXPECTED]:unauthorized"):
        contract.withdraw_policy_fees()

    direct_vm.sender = direct_owner
    contract.withdraw_policy_fees()
    assert contract.get_policy_fee()["pending"] == 0

    with direct_vm.expect_revert("[EXPECTED]:no_fees"):
        contract.withdraw_policy_fees()


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



def test_private_hosts_are_refused(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    for url in (
        "https://127.0.0.1/rules",
        "https://localhost/rules",
        "https://metadata.google.internal/rules",
        "https://intranet.local/rules",
    ):
        with direct_vm.expect_revert("[EXPECTED]:invalid_source_url"):
            contract.register_policy(POLICY_ID, "screen", url, GUIDANCE)


def test_assessment_records_the_rules_digest(
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

    assessment_id = contract.assess(
        POLICY_ID, "A", "B", "100 EUR", "context", "ref-1"
    )

    digest = contract.get_assessment(assessment_id)["rules_digest"]
    assert len(digest) == 64
    assert all(character in "0123456789abcdef" for character in digest)


def test_only_the_owner_may_nominate_a_successor(
    direct_vm, direct_deploy, direct_alice
):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert("[EXPECTED]:unauthorized"):
        contract.transfer_ownership("0x" + "11" * 20)


def test_ownership_needs_the_successor_to_accept(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob
):
    contract = direct_deploy("contracts/ClauseGuard.py")

    direct_vm.sender = direct_owner
    contract.transfer_ownership(direct_alice)

    # Only the nominated address can accept.
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("[EXPECTED]:not_pending_owner"):
        contract.accept_ownership()

    direct_vm.sender = direct_alice
    contract.accept_ownership()
    # The nominee is in charge now, and the nomination is cleared.
    contract.register_policy("alice-policy", "Alice screen", RULES_URL, GUIDANCE)
    assert contract.get_pending_owner() == "0x" + "0" * 40

    # The old owner and a third party are both out.
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("[EXPECTED]:unauthorized"):
        contract.set_policy_active(POLICY_ID, False)

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("[EXPECTED]:unauthorized"):
        contract.set_policy_active(POLICY_ID, False)


def test_zero_owner_is_refused(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("[EXPECTED]:zero_owner"):
        contract.transfer_ownership("0x" + "0" * 40)


def test_accept_without_a_nomination_reverts(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("[EXPECTED]:no_pending_owner"):
        contract.accept_ownership()
