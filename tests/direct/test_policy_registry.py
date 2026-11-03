"""Policy registry: ownership, validation, activation."""

POLICY_ID = "eu-payments"
RULES_URL = "https://rules.example.com/eu/payments"
GUIDANCE = "Transfers above 10000 EUR to a sanctioned counterparty are prohibited."


def test_owner_can_register_policy(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ComplianceGate.py")
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


def test_owner_can_update_policy(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ComplianceGate.py")
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


def test_duplicate_policy_reverts(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ComplianceGate.py")
    direct_vm.sender = direct_owner

    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)

    with direct_vm.expect_revert("[EXPECTED]:policy_exists"):
        contract.register_policy(POLICY_ID, "duplicate", RULES_URL, GUIDANCE)


def test_non_owner_cannot_register(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/ComplianceGate.py")
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert("[EXPECTED]:unauthorized"):
        contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)


def test_non_owner_cannot_deactivate(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/ComplianceGate.py")
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert("[EXPECTED]:unauthorized"):
        contract.set_policy_active(POLICY_ID, False)


def test_insecure_source_url_reverts(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ComplianceGate.py")
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("[EXPECTED]:invalid_source_url"):
        contract.register_policy(
            POLICY_ID, "EU payments screen", "http://rules.example.com/eu", GUIDANCE
        )


def test_empty_guidance_reverts(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ComplianceGate.py")
    direct_vm.sender = direct_owner

    with direct_vm.expect_revert("[EXPECTED]:empty_guidance"):
        contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, "   ")


def test_policy_can_be_deactivated(direct_vm, direct_deploy, direct_owner):
    contract = direct_deploy("contracts/ComplianceGate.py")
    direct_vm.sender = direct_owner

    contract.register_policy(POLICY_ID, "EU payments screen", RULES_URL, GUIDANCE)
    contract.set_policy_active(POLICY_ID, False)

    assert contract.get_policy(POLICY_ID)["active"] is False


def test_unknown_policy_view_reverts(direct_vm, direct_deploy):
    contract = direct_deploy("contracts/ComplianceGate.py")

    with direct_vm.expect_revert("[EXPECTED]:unknown_policy"):
        contract.get_policy("does-not-exist")


def test_owner_is_recorded(direct_vm, direct_deploy):
    contract = direct_deploy("contracts/ComplianceGate.py")
    owner = contract.get_owner()
    assert owner.startswith("0x")
    assert len(owner) == 42
