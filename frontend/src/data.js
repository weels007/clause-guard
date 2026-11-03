export const OWNER_ADDRESS = "0xE8b3e800d08727D25156a44cD1609F793bd0Af5a";
export const STRANGER_ADDRESS = "0x0C0Fd005478Cef9219451BBD19Dfc6C0586fC1Ad";

export const DEMO_POLICIES = [
  {
    policy_id: "eu-payments",
    name: "EU payments screen",
    source_url: "https://rules.example.com/eu/payments",
    guidance:
      "Transfers above 10000 EUR to a sanctioned counterparty are prohibited. Anything below the threshold is allowed.",
    rules:
      "Article 4. Transfers above 10000 EUR to a sanctioned counterparty are prohibited. Transfers below that threshold are allowed when the counterparty is not on the sanctions list.",
    version: 2,
    active: true,
    assessments: 2,
  },
  {
    policy_id: "us-ofac",
    name: "OFAC screening",
    source_url: "https://rules.example.com/us/ofac",
    guidance:
      "Any transfer touching a party on the OFAC list must be refused and scored as high risk.",
    rules:
      "Section 2. A transfer to a party on the OFAC list is prohibited. A transfer to a cleared counterparty is permitted and carries low residual risk.",
    version: 1,
    active: true,
    assessments: 1,
  },
];

export const DEMO_ASSESSMENTS = [
  {
    assessment_id: "ca-1",
    policy_id: "eu-payments",
    policy_version: 2,
    subject: "ACME GmbH",
    counterparty: "Acme Supplier GmbH",
    amount: "4200 EUR",
    context: "Monthly SaaS invoice, first-time vendor",
    verdict: "COMPLIANT",
    risk_score: 20,
    risk_band: "LOW",
    rule_quote: "transfers below that threshold are allowed when the counterparty is not on the sanctions list",
    rules_digest: "b41f0f6e2f1a9c0a7d8c0e3d1f2a4b5c6d7e8f9012345678abcdef0123456789",
    findings: "Below the 10000 EUR threshold and the counterparty is not listed.",
    submit_ref: "demo-1",
    requester: "0xE8b3e800d08727D25156a44cD1609F793bd0Af5a",
    created_at: "2026-11-02T09:14:00Z",
    consensus: { verdict: "COMPLIANT", risk_level: "LOW", agree: true, rotations: 0 },
  },
  {
    assessment_id: "ca-2",
    policy_id: "eu-payments",
    policy_version: 2,
    subject: "ACME GmbH",
    counterparty: "New Vendor Ltd",
    amount: "9800 EUR",
    context: "First invoice from a vendor with no history",
    verdict: "REVIEW",
    risk_score: 50,
    risk_band: "MEDIUM",
    rule_quote: "",
    rules_digest: "b41f0f6e2f1a9c0a7d8c0e3d1f2a4b5c6d7e8f9012345678abcdef0123456789",
    findings:
      "The rules are silent on brand-new counterparties. Citation could not be grounded in the source. [citation could not be grounded in the source]",
    submit_ref: "demo-2",
    requester: "0xE8b3e800d08727D25156a44cD1609F793bd0Af5a",
    created_at: "2026-11-02T09:20:00Z",
    consensus: { verdict: "REVIEW", risk_level: "MEDIUM", agree: true, rotations: 1 },
  },
  {
    assessment_id: "ca-3",
    policy_id: "us-ofac",
    policy_version: 1,
    subject: "Northwind Trading LLC",
    counterparty: "Cleared Partner Bank",
    amount: "12500 USD",
    context: "Payroll funding through a bank that was screened last quarter",
    verdict: "COMPLIANT",
    risk_score: 20,
    risk_band: "LOW",
    rule_quote: "a transfer to a cleared counterparty is permitted and carries low residual risk",
    rules_digest: "9c2d4a1b7e60f3c8a5d21e94b0c7f6a32d8e5b1439fa67c0d1e2b3a4c5d6e7f8",
    findings: "The counterparty is cleared, so the permitted-transfer sentence applies.",
    submit_ref: "demo-3",
    requester: "0xE8b3e800d08727D25156a44cD1609F793bd0Af5a",
    created_at: "2026-11-02T09:31:00Z",
    consensus: { verdict: "COMPLIANT", risk_level: "LOW", agree: true, rotations: 0 },
  },
];

export const DEMO_ESCROWS = [
  {
    escrow_id: "esc-1",
    funder: "0xE8b3e800d08727D25156a44cD1609F793bd0Af5a",
    payee: "0x0C0Fd005478Cef9219451BBD19Dfc6C0586fC1Ad",
    amount: 1000,
    assessment_id: "ca-1",
    reference: "PO-1",
    status: "FUNDED",
    created_ts: Math.floor(Date.now() / 1000) - 3600,
  },
];
