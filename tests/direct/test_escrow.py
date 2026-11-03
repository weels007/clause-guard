"""Escrow: deposit GEN against a COMPLIANT assessment, funder-only exits.

Two rules drive this suite:

1. Only the account that deposited can move money out (release or refund).
2. A payable call never reverts once value is attached, so a refused target
   becomes a refundable orphan instead of stranding the GEN.

Direct mode cannot execute external EthSend messages, so the payout call itself
is not exercised here. What is tested is the part that protects the money: who
may create a deposit, who may release or refund it, and that a stranger, a
non-compliant verdict, or a recycled assessment can never move funds.
"""

import json

POLICY_ID = "eu-payments"
RULES_URL = "https://rules.example.com/eu/payments"
GUIDANCE = "Transfers above 10000 EUR to a sanctioned counterparty are prohibited."
QUOTE = "sanctioned transfers are prohibited"


def _mock(direct_vm, verdict, score):
    direct_vm.mock_web(
        r".*rules\.example\.com.*",
        {"status": 200, "body": "Article 4: sanctioned transfers are prohibited."},
    )
    direct_vm.mock_llm(
        r".*\[\[COMPLIANCE_ASSESSMENT\]\].*",
        json.dumps(
            {
                "verdict": verdict,
                "risk_score": score,
                "rule_quote": QUOTE,
                "findings": "article 4",
            }
        ),
    )


def _compliant_assessment(direct_vm, direct_deploy, direct_owner, ref="ref-1"):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner
    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)
    _mock(direct_vm, "COMPLIANT", 10)
    assessment_id = contract.assess(
        POLICY_ID, "ACME GmbH", "Vendor Co", "5000 EUR", "invoice", ref
    )
    return contract, assessment_id


def test_create_escrow_records_the_deposit(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    contract, assessment_id = _compliant_assessment(
        direct_vm, direct_deploy, direct_owner
    )

    direct_vm.value = 1000
    escrow_id = contract.create_escrow(assessment_id, direct_alice, "PO-1")
    direct_vm.value = 0

    assert escrow_id == "esc-1"

    escrow = contract.get_escrow(escrow_id)
    assert escrow["amount"] == 1000
    assert escrow["status"] == "FUNDED"
    assert escrow["assessment_id"] == assessment_id
    assert escrow["payee"] == direct_alice.hex()

    ledger = contract.get_ledger()
    assert ledger["total_deposited"] == 1000
    assert ledger["locked_total"] == 1000
    assert ledger["total_out"] == 0


def test_zero_deposit_is_rejected(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    contract, assessment_id = _compliant_assessment(
        direct_vm, direct_deploy, direct_owner
    )

    # No value is attached, so reverting here cannot strand anything.
    with direct_vm.expect_revert("[EXPECTED]:zero_deposit"):
        contract.create_escrow(assessment_id, direct_alice, "PO-1")

    assert contract.get_ledger()["total_deposited"] == 0


def test_non_compliant_assessment_becomes_a_refundable_orphan(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner
    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)

    _mock(direct_vm, "NON_COMPLIANT", 90)
    assessment_id = contract.assess(
        POLICY_ID, "ACME GmbH", "Sanctioned LLC", "90000 EUR", "wire", "ref-2"
    )

    direct_vm.value = 1000
    escrow_id = contract.create_escrow(assessment_id, direct_alice, "PO-1")
    direct_vm.value = 0

    escrow = contract.get_escrow(escrow_id)
    assert escrow["status"] == "ORPHAN"
    assert escrow["assessment_id"] == ""
    assert escrow["amount"] == 1000

    # The money is on the books and owned by the sender, so it can come back.
    ledger = contract.get_ledger()
    assert ledger["total_deposited"] == 1000
    assert ledger["locked_total"] == 1000


def test_stranger_deposit_against_someone_elses_assessment_is_orphaned(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob
):
    contract, assessment_id = _compliant_assessment(
        direct_vm, direct_deploy, direct_owner
    )

    direct_vm.sender = direct_bob
    direct_vm.value = 1000
    escrow_id = contract.create_escrow(assessment_id, direct_alice, "PO-1")
    direct_vm.value = 0

    # Bob's GEN is recorded against Bob, so only Bob can get it back.
    assert contract.get_escrow(escrow_id)["status"] == "ORPHAN"

    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("[EXPECTED]:not_funder"):
        contract.refund_escrow(escrow_id)


def test_assessment_cannot_be_recycled(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    contract, assessment_id = _compliant_assessment(
        direct_vm, direct_deploy, direct_owner
    )

    direct_vm.value = 1000
    first = contract.create_escrow(assessment_id, direct_alice, "PO-1")
    second = contract.create_escrow(assessment_id, direct_alice, "PO-2")
    direct_vm.value = 0

    assert contract.get_escrow(first)["status"] == "FUNDED"
    assert contract.get_escrow(second)["status"] == "ORPHAN"
    assert contract.get_ledger()["total_deposited"] == 2000


def test_payee_cannot_be_the_funder(
    direct_vm, direct_deploy, direct_owner
):
    contract, assessment_id = _compliant_assessment(
        direct_vm, direct_deploy, direct_owner
    )

    direct_vm.value = 1000
    escrow_id = contract.create_escrow(assessment_id, direct_owner, "PO-1")
    direct_vm.value = 0

    assert contract.get_escrow(escrow_id)["status"] == "ORPHAN"


def test_zero_address_payee_is_orphaned(
    direct_vm, direct_deploy, direct_owner
):
    contract, assessment_id = _compliant_assessment(
        direct_vm, direct_deploy, direct_owner
    )

    direct_vm.value = 1000
    escrow_id = contract.create_escrow(assessment_id, "0x" + "0" * 40, "PO-1")
    direct_vm.value = 0

    escrow = contract.get_escrow(escrow_id)
    assert escrow["status"] == "ORPHAN"
    assert escrow["payee"] == "0" * 40


def test_unparseable_payee_is_orphaned_and_cannot_revert_the_deposit(
    direct_vm, direct_deploy, direct_owner
):
    contract, assessment_id = _compliant_assessment(
        direct_vm, direct_deploy, direct_owner
    )

    direct_vm.value = 1000
    escrow_id = contract.create_escrow(assessment_id, "not-an-address", "PO-1")
    direct_vm.value = 0

    assert contract.get_escrow(escrow_id)["status"] == "ORPHAN"
    assert contract.get_ledger()["total_deposited"] == 1000


def test_stranger_cannot_release(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob
):
    contract, assessment_id = _compliant_assessment(
        direct_vm, direct_deploy, direct_owner
    )

    direct_vm.value = 1000
    escrow_id = contract.create_escrow(assessment_id, direct_alice, "PO-1")
    direct_vm.value = 0

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("[EXPECTED]:not_funder"):
        contract.release_escrow(escrow_id)

    # Nothing moved: the escrow is still funded and the ledger untouched.
    assert contract.get_escrow(escrow_id)["status"] == "FUNDED"
    assert contract.get_ledger()["locked_total"] == 1000


def test_stranger_cannot_refund_to_themselves(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob
):
    contract, assessment_id = _compliant_assessment(
        direct_vm, direct_deploy, direct_owner
    )

    direct_vm.value = 1000
    escrow_id = contract.create_escrow(assessment_id, direct_alice, "PO-1")
    direct_vm.value = 0

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("[EXPECTED]:not_funder"):
        contract.refund_escrow(escrow_id)

    assert contract.get_escrow(escrow_id)["status"] == "FUNDED"
    assert contract.get_ledger()["total_out"] == 0


def test_orphan_cannot_be_released(direct_vm, direct_deploy, direct_owner, direct_alice):
    contract, assessment_id = _compliant_assessment(
        direct_vm, direct_deploy, direct_owner
    )

    direct_vm.value = 1000
    # Same payee as funder: refused, so this deposit is an orphan.
    escrow_id = contract.create_escrow(assessment_id, direct_owner, "PO-1")
    direct_vm.value = 0

    with direct_vm.expect_revert("[EXPECTED]:escrow_closed"):
        contract.release_escrow(escrow_id)


def test_escrow_is_not_expired_when_created(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    direct_vm.warp("2024-01-01T00:00:00Z")
    contract, assessment_id = _compliant_assessment(
        direct_vm, direct_deploy, direct_owner
    )

    direct_vm.value = 1000
    escrow_id = contract.create_escrow(assessment_id, direct_alice, "PO-1")
    direct_vm.value = 0

    assert contract.is_escrow_expired(escrow_id) is False

    # A day later the funder is still the only one who may unwind it.
    direct_vm.warp("2024-01-02T00:00:00Z")
    assert contract.is_escrow_expired(escrow_id) is False

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("[EXPECTED]:not_funder"):
        contract.refund_escrow(escrow_id)


def test_escrow_expires_after_the_timeout(
    direct_vm, direct_deploy, direct_owner, direct_alice
):
    direct_vm.warp("2024-01-01T00:00:00Z")
    contract, assessment_id = _compliant_assessment(
        direct_vm, direct_deploy, direct_owner
    )

    direct_vm.value = 1000
    escrow_id = contract.create_escrow(assessment_id, direct_alice, "PO-1")
    direct_vm.value = 0

    assert contract.is_escrow_expired(escrow_id) is False
    # The escrow did not exist a moment ago, so a stranger can still not
    # touch it: the timeout is the only thing that widens who may unwind.
    direct_vm.warp("2024-01-31T00:00:00Z")
    assert contract.is_escrow_expired(escrow_id) is True


def test_unknown_escrow_reverts(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ClauseGuard.py")
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("[EXPECTED]:unknown_escrow"):
        contract.release_escrow("esc-99")

    with direct_vm.expect_revert("[EXPECTED]:unknown_escrow"):
        contract.refund_escrow("esc-99")

    with direct_vm.expect_revert("[EXPECTED]:unknown_escrow"):
        contract.get_escrow("esc-99")


def test_escrows_are_isolated_per_funder(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob
):
    contract, assessment_id = _compliant_assessment(
        direct_vm, direct_deploy, direct_owner
    )

    direct_vm.value = 1000
    first = contract.create_escrow(assessment_id, direct_alice, "PO-1")
    direct_vm.value = 0

    direct_vm.sender = direct_bob
    _mock(direct_vm, "COMPLIANT", 10)
    bob_assessment = contract.assess(
        POLICY_ID, "Bob Ltd", "Vendor Co", "2000 EUR", "invoice", "bob-ref"
    )

    direct_vm.value = 500
    second = contract.create_escrow(bob_assessment, direct_alice, "BOB-1")
    direct_vm.value = 0

    assert first == "esc-1"
    assert second == "esc-2"

    # Bob's escrow is not reachable by the owner and vice versa.
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("[EXPECTED]:not_funder"):
        contract.release_escrow(second)

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("[EXPECTED]:not_funder"):
        contract.release_escrow(first)

    ledger = contract.get_ledger()
    assert ledger["total_deposited"] == 1500
    assert ledger["locked_total"] == 1500
