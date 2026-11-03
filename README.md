# ClauseGuard

Automated compliance and risk assessment on GenLayer.

An Intelligent Contract that reads a policy's rules straight from the web, asks an
LLM to decide whether a transaction complies with those rules, scores its residual
risk, and stores an auditable verdict — with validators independently
re-deriving the decision before anything is written on-chain.

## Why GenLayer

Classic smart contracts cannot read a regulation page or judge whether a payment
"looks like" a sanctioned transfer. GenLayer contracts can, because web access and
LLM calls run inside non-deterministic blocks, and the Equivalence Principle makes
validators agree on the outcome before state changes.

## How a verdict is produced

1. **Policy registry** — the owner registers a policy: an id, a rules URL, and
   analyst guidance. URLs must be `https://`.
2. **Rule fetch** — inside the non-deterministic block the contract renders the
   rules page as text (truncated to `MAX_RULES_CHARS`).
3. **LLM decision** — the model returns `verdict` (`COMPLIANT` / `NON_COMPLIANT` /
   `REVIEW`), a `risk_score` (0–100), and `findings`. The response is normalised:
   aliases like `PASS` or `MANUAL_REVIEW` are mapped, the score is clamped.
4. **Validator** — re-runs the whole fetch-and-judge step independently and
   compares only the decision fields: `verdict`, `risk_band`, and `risk_score`
   within `RISK_SCORE_TOLERANCE` (10). `findings` is stored but never compared,
   since wording varies between models.
5. **Storage** — only after consensus: the assessment is written, the id counter
   advances, and the policy's assessment count increments.

Storage reads never happen inside the non-deterministic block — every value the
leader needs is copied into memory first.

### Error consensus

Failures are classified so that validators agree for the right reasons:

- `[EXPECTED]` / `[EXTERNAL]` — deterministic (bad input, empty rules page). Must
  match exactly on both nodes.
- `[TRANSIENT]` — unreachable source. Both nodes transient means agreement.
- `[LLM_ERROR]` — malformed model output. Always disagree, forcing a retry with a
  different leader.

## Contract API

**Write**

| Method | Who | Purpose |
|---|---|---|
| `register_policy(policy_id, name, source_url, guidance)` | owner | Add a rules-backed policy |
| `update_policy(policy_id, name, source_url, guidance)` | owner | Change a policy's source or guidance |
| `set_policy_active(policy_id, active)` | owner | Enable/disable a policy |
| `assess(policy_id, subject, counterparty, amount, context)` | anyone | Run the assessment, returns assessment id (`ca-1`, `ca-2`, …) |

**View**

| Method | Returns |
|---|---|
| `get_owner()` | owner address |
| `get_policy(policy_id)` | policy record |
| `get_policies()` | all policies keyed by id |
| `get_assessment(assessment_id)` | one assessment |
| `get_assessments()` | all assessments keyed by id |
| `get_assessment_ids()` | `{"ids": [...]}` in insertion order |
| `get_summary()` | totals: total, compliant, non_compliant, review, high_risk, policies |

Risk bands: `LOW` (0–33), `MEDIUM` (34–66), `HIGH` (67–100).

## Layout

```
contracts/ClauseGuard.py     the Intelligent Contract
tests/direct/                 in-memory tests (no Docker, milliseconds each)
tests/integration/            Studio-mode tests (needs gltest + an environment)
gltest.config.yaml            network config for Studio-mode integration tests
.github/workflows/ci.yml      lint + direct-mode tests
requirements.txt              pinned SDK, test suite, linter
```

## Running it locally

```bash
pip install -r requirements.txt

# 1. lint — catches forbidden imports, invalid storage types, nondet misuse
genvm-lint check contracts/ClauseGuard.py

# 2. direct-mode tests — in-memory, mocked web + LLM
pytest tests/direct/ -v

# 3. integration tests — needs GenLayer Studio (Docker) or hosted studionet
gltest tests/integration/ -v -s --network studionet
```

## Developing without a terminal

This repository is set up so the whole loop works through GitHub Actions:

- `Lint Contracts` runs `genvm-lint check`.
- `Direct Mode Tests` runs `pytest tests/direct/`.

Push to `main` (or open a pull request) and read the job logs. Direct mode covers
contract logic, storage, access control, and consensus comparison
(`tests/direct/test_consensus.py` replays the validator against a stored leader
result); a failure there is a real failure, not a guess. Only true
multi-validator behaviour needs `gltest` against Studio.

## Extending it

- **Real rule sources** — point a policy at a public sanctions list, a regulator's
  fee schedule, or an internal policy page. The contract only needs text.
- **Rule snapshots** — store a hash of the fetched rules text alongside the
  verdict so an auditor can prove which version was applied.
- **Frontend** — read `get_summary()` and `get_assessments()` through `genlayer-js`
  to build a review queue for `REVIEW` verdicts.
