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

1. **Policy registry** — the owner registers a policy: an id (lowercased, bounded
   charset), a rules URL, and analyst guidance. URLs must be `https://`. Once a
   policy has produced an assessment it is locked for edits, so every stored
   verdict stays reproducible against the rules that produced it.
2. **Rule fetch** — inside the non-deterministic block the contract renders the
   rules page as text (truncated to `MAX_RULES_CHARS`).
3. **LLM decision** — the model returns `verdict`, a raw `risk_score`, a
   `rule_quote`, and `findings`. Two normalisations happen before anything is
   compared: the score is quantised to a 10-point bucket, and the quote must be a
   verbatim substring of the fetched rules text, so a hallucinated citation fails
   the assessment instead of being stored.
4. **Validator** — re-runs the whole fetch-and-judge step independently and
   requires exact equality on `verdict` and on the quantised `risk_bucket`.
   Because the stored score *is* the bucket, the value written on-chain is
   precisely the value both nodes agreed on — never two raw scores that merely
   shared a band.
5. **Storage** — only after consensus: the assessment is written (with policy
   version, verified quote, and submit reference), the id counter advances, and
   the O(1) summary counters increment.

Storage reads never happen inside the non-deterministic block — every value the
leader needs is copied into memory first.

### Error consensus

Failures are classified so that validators agree for the right reasons:

- `[EXPECTED]` / `[EXTERNAL]` — deterministic (bad input, empty rules page). Must
  match exactly on tag and code.
- `[TRANSIENT]` — unreachable source. Both nodes transient means agreement.
- `[LLM_ERROR]` — malformed or ungrounded model output. Always disagree, forcing
  a retry with a different leader.

Errors are compared by tag and first code segment, not by full message text, so
two nodes reporting the same deterministic failure agree rather than deadlocking
on differing stack detail.

## Contract API

**Write**

| Method | Who | Purpose |
|---|---|---|
| `register_policy(policy_id, name, source_url, guidance)` | owner | Add a rules-backed policy |
| `update_policy(policy_id, name, source_url, guidance)` | owner | Change a policy that has no assessments yet |
| `set_policy_active(policy_id, active)` | owner | Enable/disable a policy |
| `assess(policy_id, subject, counterparty, amount, context, submit_ref)` | anyone | Run the assessment, returns assessment id (`ca-1`, `ca-2`, …) |
| `create_escrow(assessment_id, payee, reference)` (payable) | anyone with their own COMPLIANT assessment | Deposit GEN against that verdict |
| `release_escrow(escrow_id)` | the escrow's funder only | Pay the payee |
| `refund_escrow(escrow_id)` | the escrow's funder only | Return the deposit to the funder |

**View**

| Method | Returns |
|---|---|
| `get_owner()` | owner address |
| `get_policy(policy_id)` | policy record (name, source, guidance, active, count, version) |
| `get_policies()` | all policies keyed by id |
| `get_assessment(assessment_id)` | one assessment incl. verified `rule_quote` and `submit_ref` |
| `get_assessments()` | all assessments keyed by id |
| `get_assessment_ids()` | `{"ids": [...]}` in insertion order |
| `get_escrow(escrow_id)` | funder, payee, amount, status, bound assessment, created_ts |
| `is_escrow_expired(escrow_id)` | whether the 30-day unwind fallback is active |
| `get_ledger()` | total_deposited, total_out, locked_total |
| `get_balance()` | GEN actually held by the contract |
| `get_summary()` | totals: total, compliant, non_compliant, review, high_risk, policies |

Risk bands: `LOW` (0–33), `MEDIUM` (34–66), `HIGH` (67–100), computed from the
quantised score that consensus agreed on.

## Escrow: money only its owner can move

An assessment on its own moves nothing. Value enters only through
`create_escrow`, which is payable and requires an assessment **you** ran whose
verdict is `COMPLIANT`:

- the deposit is recorded against `gl.message.sender_address` as `funder`;
- the assessment is marked used, so one verdict can never back two escrows;
- `create_escrow` is the only payable entry point, so value can only arrive
  attached to a recorded funder — there is no bare-transfer path into the
  contract and therefore no ownerless GEN;
- a payable call never reverts once value is attached: if the target is refused
  (wrong verdict, someone else's assessment, recycled verdict, invalid or zero
  payee), the deposit is stored as an `ORPHAN` escrow owned by the sender and
  can be pulled back with `refund_escrow`. Money must never be trapped by a
  failed call.

Both exits check the stored funder against the caller:

- `release_escrow` pays the payee — only the funder may call it;
- `refund_escrow` returns the deposit — the funder may always call it, and
  after `ESCROW_TIMEOUT_SECONDS` (30 days) anyone may trigger it, but the
  money still goes to the stored funder. That is a liveness fallback, never a
  way to take custody.

The payee has no path to pull funds, a stranger cannot release or refund, and a
`NON_COMPLIANT` or `REVIEW` verdict cannot be funded at all. Money leaves via
`emit_transfer` to an EOA, with the ledger updated first and the transfer last:
if the transfer fails the whole transaction reverts and the ledger rolls back
with it. Before any payout the contract checks both that the ledger still owes
the amount and that the real balance still covers it, so a transfer that left
while the state was rolled back cannot be paid twice. Solvency is tracked by the
storage ledger (`total_deposited`, `locked_total`, `total_out`) — `self.balance`
is only used as that second net.

## Security properties

- **Double submit** — every assessment carries a caller-scoped `submit_ref`, and
  the pair (requester, ref) is stored. A retry or duplicate submission reverts
  with `[EXPECTED]:duplicate_submit` instead of minting a second record. Refs are
  scoped per caller, so one account cannot burn another's.
- **Caller-supplied text is untrusted** — `subject`, `counterparty`, `amount` and
  `context` are whitespace-normalised, length-capped, and stripped of angle
  brackets so they cannot break out of the `<transaction>` block. The prompt
  frames them as facts that must never be read as instructions.
- **Grounded reasoning** — `rule_quote` is verified as a substring of the fetched
  rules text, so the stored justification cannot invent a rule. It is descriptive
  only; no later computation reads it.
- **Bounded growth** — at most `MAX_POLICIES` (100) policies and
  `MAX_ASSESSMENTS` (5000) assessments; ids, URLs, names and guidance are all
  length-capped.
- **Bounded reads** — `get_summary()` reads write-time counters rather than
  walking the whole assessment set.
- **Reproducibility** — a policy cannot be re-pointed at new rules once it has
  produced assessments; register a new policy id instead.
- **Funder-only custody** — no method transfers value except `release_escrow`
  and `refund_escrow`. Release requires the stored funder. Refund allows the
  funder always, and anyone after the 30-day timeout, but the payout target is
  always the stored funder, so no third party can redirect it.
  `create_escrow` rejects a payee that is the funder or the zero address.
- **No orphaned funds** — `create_escrow` is the only payable entry point, so
  value can only enter through a call that records a funder, and a refused
  deposit becomes a refundable `ORPHAN` instead of being stranded by a revert.
  The ledger invariant `total_deposited == total_out + locked_total` holds
  after every state change.
- **Citations survive formatting** — `rule_quote` is matched after folding both
  sides to letters and digits, so punctuation, casing or line wrapping cannot
  make a genuine citation fail or let a fake one pass.

Known limits: there is no ownership transfer yet, so a lost owner key freezes
policy registration (existing assessments keep working), and `findings` is stored
as descriptive text that is never fed back into a decision.

## Integration on studionet

`gltest` generates the accounts it uses — there is no wallet to connect and no
private key to paste. `default_account` signs the deploy and the owner-only
calls; `accounts[1]`, `accounts[2]` are further signers the framework creates
for the adversarial cases. They are generated per run, so no real funds are
involved. Only `testnet_bradbury` needs keys of your own, and those live in
`gltest.config.yaml` under `accounts:` and are read from `.env`.

```bash
gltest tests/integration/ -v -s --network studionet
```

The suite exercises every method in order: policy registry and its
authorisation guards, a real assessment (live fetch + live LLM + real
consensus), submit-ref replay, policy locking, prompt-tag neutralisation,
escrow deposit, a stranger trying to release and refund, a real payout, and
policy-id normalisation.

Two facts about it:

- the assessment verdict is whatever consensus produced, so the tests assert
  that consensus happened and that the stored record is well formed (score is a
  10-point bucket, citation is grounded), never which verdict came out;
- the escrow unwind branches on the stored status — `FUNDED` releases to the
  payee, `ORPHAN` refunds to the funder — so one real transfer still happens
  either way.

`.github/workflows/integration.yml` runs the suite when the contract changes
or on demand (`workflow_dispatch`): it deploys to studionet, pays for real
execution, and depends on live web and LLM behaviour.

## Addresses

From the studionet run of commit `83a53da`:

| Role | Address |
|---|---|
| ClauseGuard contract | `0xe0755aeb89aDC69d1D8C2773972680fCFF16bFE9` |
| Deployment signer (owner) | `0x5AcF9e4Cc50fB72eb8DA201A72cA05a4F7e0A61e` |
| Escrow payee (constant in the suite) | `0xabababababababababababababababababababab` |

**Read this before sending GEN.** Those addresses are from one run and are
ephemeral: every studionet run generates fresh accounts and deploys a new
contract, so GEN sent to them now sits under a key nobody holds and against a
contract the next run will not touch. The payee address is a constant burn
target — never fund it.

### Funding the escrow for real

To make "send GEN, watch it refund" meaningful, pin the signer:

1. create three throwaway keys (`genlayer account create`, or any wallet) —
   never a wallet you care about;
2. add them as repository secrets named `CLAUSEGUARD_TEST_KEY`,
   `CLAUSEGUARD_STRANGER_KEY`, `CLAUSEGUARD_PAYEE_KEY`;
3. uncomment the `accounts:` block in `gltest.config.yaml`;
4. fund the `CLAUSEGUARD_TEST_KEY` address, then run the workflow.
   `default_account` is now a fixed address, so the balance survives between
   runs and `create_escrow` / `refund_escrow` move real value.

Studionet's faucet is the droplet in the Studio account selector and funds the
Studio account, not an arbitrary address. For "send GEN to this address and
watch it move", Bradbury is the practical network: its faucet accepts an
address, and the same suite runs with `--network testnet_bradbury`.

## Seeing transactions in the explorer

Direct mode never touches a chain, so nothing it runs can appear anywhere. Studio
mode against studionet is different: `factory.deploy()` and every `.transact()`
are real transactions on that network.

The suite prints the deployed address once and the id of every transaction, so
run it with `-s` and the output looks like:

```
[clauseguard] deployed at 0x...
[clauseguard] register_policy -> 0x...
[clauseguard] assess -> 0x...
[clauseguard] create_escrow -> 0x...
```

Paste either the contract address or a transaction id into the Studio explorer
([explorer-studio.genlayer.com](https://explorer-studio.genlayer.com)) to see
the deployment and each call against the contract.

Two caveats:

- studionet state is temporary — that trail can disappear when the environment
  is reset. For a persistent trail, run the same suite against Bradbury
  (`--network testnet_bradbury`), which needs your own funded keys.
- a write that reverts still exists on the network: the assertion says it
  failed, the explorer shows where.

The same trail can be produced without tests: deploy from the Studio UI and use
its Execute Transactions panel, or use the CLI (`genlayer deploy`,
`genlayer write`).

## Layout

```
contracts/ClauseGuard.py      the Intelligent Contract
tests/direct/                 in-memory tests (no Docker, milliseconds each)
tests/integration/            Studio-mode tests (needs gltest + an environment)
gltest.config.yaml            network config for Studio-mode integration tests
.github/workflows/ci.yml      lint + direct-mode tests
.github/workflows/integration.yml  Studio-mode suite, manual dispatch
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
- **Rule snapshots** — store a digest of the fetched rules text alongside the
  verdict so an auditor can prove which exact version was applied.
- **Review queue** — read `get_summary()` and `get_assessments()` through
  `genlayer-js` to build a queue of `REVIEW` verdicts for human analysts.
