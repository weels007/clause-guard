# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

import json
from dataclasses import dataclass

from genlayer import *

# Stable marker embedded in every rule-evaluation prompt.
# Tests use it to match LLM mocks without depending on prompt wording.
COMPLIANCE_MARKER = "[[COMPLIANCE_ASSESSMENT]]"

DECISION_COMPLIANT = "COMPLIANT"
DECISION_NON_COMPLIANT = "NON_COMPLIANT"
DECISION_REVIEW = "REVIEW"

BAND_LOW = "LOW"
BAND_MEDIUM = "MEDIUM"
BAND_HIGH = "HIGH"

# Error prefixes. Validators use them to decide whether two nodes
# failing the same way counts as agreement.
ERROR_EXPECTED = "[EXPECTED]"
ERROR_EXTERNAL = "[EXTERNAL]"
ERROR_TRANSIENT = "[TRANSIENT]"
ERROR_LLM = "[LLM_ERROR]"

MAX_RULES_CHARS = 12000
MAX_FINDINGS_CHARS = 800
MAX_CONTEXT_CHARS = 600
RISK_SCORE_TOLERANCE = 10


@allow_storage
@dataclass
class Policy:
    name: str
    source_url: str
    guidance: str
    active: bool
    assessments: u32


@allow_storage
@dataclass
class Assessment:
    policy_id: str
    subject: str
    counterparty: str
    amount: str
    context: str
    verdict: str
    risk_score: u32
    risk_band: str
    findings: str
    requester: Address
    created_at: str


def _risk_band(score: int) -> str:
    if score >= 67:
        return BAND_HIGH
    if score >= 34:
        return BAND_MEDIUM
    return BAND_LOW


def _clamp_score(value) -> int:
    try:
        score = int(round(float(str(value).strip())))
    except (TypeError, ValueError):
        raise gl.vm.UserError(ERROR_LLM + ":bad_risk_score")
    if score < 0:
        return 0
    if score > 100:
        return 100
    return score


def _normalize_decision(raw: str) -> str:
    value = raw.strip().upper().replace("-", "_").replace(" ", "_")
    if value in ("COMPLIANT", "COMPLY", "PASS", "APPROVED", "ALLOW", "ALLOWED"):
        return DECISION_COMPLIANT
    if value in ("NON_COMPLIANT", "NONCOMPLIANT", "FAIL", "REJECT", "REJECTED", "BLOCK", "BLOCKED"):
        return DECISION_NON_COMPLIANT
    if value in ("REVIEW", "MANUAL_REVIEW", "ESCALATE", "UNCLEAR", "UNKNOWN", "INCONCLUSIVE"):
        return DECISION_REVIEW
    raise gl.vm.UserError(ERROR_LLM + ":unknown_verdict:" + value[:40])


def _coerce_payload(raw) -> dict:
    """Accept a parsed object, a JSON string, or bytes and return a dict."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", "replace")
    if isinstance(raw, str):
        text = raw.strip()
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise gl.vm.UserError(ERROR_LLM + ":no_json_object")
        try:
            payload = json.loads(text[start : end + 1])
        except Exception:
            raise gl.vm.UserError(ERROR_LLM + ":unparsable_json")
        if not isinstance(payload, dict):
            raise gl.vm.UserError(ERROR_LLM + ":json_not_an_object")
        return payload
    raise gl.vm.UserError(ERROR_LLM + ":unsupported_llm_response")


def _build_verdict(raw) -> dict:
    """Turn a raw LLM response into the canonical decision payload.

    Only the fields returned here are compared between leader and validator,
    so the shape must stay small and stable.
    """
    payload = _coerce_payload(raw)

    raw_decision = payload.get("verdict", payload.get("decision", ""))
    decision = _normalize_decision(str(raw_decision))

    raw_score = payload.get("risk_score", payload.get("riskScore", 50))
    score = _clamp_score(raw_score)

    findings = str(payload.get("findings", payload.get("rationale", ""))).strip()
    if len(findings) > MAX_FINDINGS_CHARS:
        findings = findings[:MAX_FINDINGS_CHARS]

    return {
        "verdict": decision,
        "risk_score": score,
        "risk_band": _risk_band(score),
        "findings": findings,
    }


def _agree_on_error(leader_res, leader_fn) -> bool:
    """Compare failures instead of results.

    Deterministic errors must match exactly; transient ones only have to be
    transient on both sides; LLM-level errors always disagree so consensus
    rotates to a new leader.
    """
    leader_msg = ""
    try:
        raw_msg = leader_res.message
        if isinstance(raw_msg, (bytes, bytearray)):
            leader_msg = raw_msg.decode("utf-8", "replace")
        else:
            leader_msg = str(raw_msg)
    except Exception:
        leader_msg = ""

    try:
        leader_fn()
    except gl.vm.UserError as err:
        validator_msg = str(err)
        if leader_msg.startswith(ERROR_EXPECTED) or leader_msg.startswith(ERROR_EXTERNAL):
            return leader_msg == validator_msg
        if leader_msg.startswith(ERROR_TRANSIENT) and validator_msg.startswith(ERROR_TRANSIENT):
            return True
        return False
    except Exception:
        return False
    return False


def _policy_to_dict(policy_id: str, policy) -> dict:
    return {
        "policy_id": policy_id,
        "name": policy.name,
        "source_url": policy.source_url,
        "guidance": policy.guidance,
        "active": policy.active,
        "assessments": policy.assessments,
    }


def _assessment_to_dict(assessment_id: str, assessment) -> dict:
    return {
        "assessment_id": assessment_id,
        "policy_id": assessment.policy_id,
        "subject": assessment.subject,
        "counterparty": assessment.counterparty,
        "amount": assessment.amount,
        "context": assessment.context,
        "verdict": assessment.verdict,
        "risk_score": assessment.risk_score,
        "risk_band": assessment.risk_band,
        "findings": assessment.findings,
        "requester": assessment.requester.as_hex,
        "created_at": assessment.created_at,
    }


class ClauseGuard(gl.Contract):
    owner: Address
    policies: TreeMap[str, Policy]
    assessments: TreeMap[str, Assessment]
    assessment_ids: DynArray[str]
    next_assessment_id: u32
    policy_count: u32

    def __init__(self):
        self.owner = gl.message.sender_address

    # ------------------------------------------------------------------
    # policy registry
    # ------------------------------------------------------------------

    def _require_owner(self) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(ERROR_EXPECTED + ":unauthorized")

    def _now(self) -> str:
        # Deterministic: the clock is pinned to the transaction timestamp, so
        # every validator sees the same value.
        try:
            raw_message = gl.message_raw
            return raw_message["datetime"]
        except Exception:
            return ""

    @gl.public.write
    def register_policy(
        self, policy_id: str, name: str, source_url: str, guidance: str
    ) -> None:
        self._require_owner()

        if not policy_id.strip():
            raise gl.vm.UserError(ERROR_EXPECTED + ":empty_policy_id")
        if policy_id in self.policies:
            raise gl.vm.UserError(ERROR_EXPECTED + ":policy_exists")
        if not name.strip():
            raise gl.vm.UserError(ERROR_EXPECTED + ":empty_name")
        if not source_url.startswith("https://"):
            raise gl.vm.UserError(ERROR_EXPECTED + ":invalid_source_url")
        if not guidance.strip():
            raise gl.vm.UserError(ERROR_EXPECTED + ":empty_guidance")

        self.policies[policy_id] = Policy(
            name=name,
            source_url=source_url,
            guidance=guidance,
            active=True,
            assessments=u32(0),
        )
        self.policy_count += 1

    @gl.public.write
    def update_policy(
        self, policy_id: str, name: str, source_url: str, guidance: str
    ) -> None:
        self._require_owner()

        if policy_id not in self.policies:
            raise gl.vm.UserError(ERROR_EXPECTED + ":unknown_policy")
        if not name.strip():
            raise gl.vm.UserError(ERROR_EXPECTED + ":empty_name")
        if not source_url.startswith("https://"):
            raise gl.vm.UserError(ERROR_EXPECTED + ":invalid_source_url")
        if not guidance.strip():
            raise gl.vm.UserError(ERROR_EXPECTED + ":empty_guidance")

        policy = self.policies[policy_id]
        policy.name = name
        policy.source_url = source_url
        policy.guidance = guidance

    @gl.public.write
    def set_policy_active(self, policy_id: str, active: bool) -> None:
        self._require_owner()

        if policy_id not in self.policies:
            raise gl.vm.UserError(ERROR_EXPECTED + ":unknown_policy")

        self.policies[policy_id].active = active

    # ------------------------------------------------------------------
    # assessment
    # ------------------------------------------------------------------

    @gl.public.write
    def assess(
        self,
        policy_id: str,
        subject: str,
        counterparty: str,
        amount: str,
        context: str,
    ) -> str:
        if policy_id not in self.policies:
            raise gl.vm.UserError(ERROR_EXPECTED + ":unknown_policy")

        stored_policy = self.policies[policy_id]
        if not stored_policy.active:
            raise gl.vm.UserError(ERROR_EXPECTED + ":policy_inactive")
        if not subject.strip():
            raise gl.vm.UserError(ERROR_EXPECTED + ":missing_subject")

        # Storage cannot be read inside a non-deterministic block, so every
        # value the leader needs is copied into memory first.
        source_url = stored_policy.source_url
        policy_name = stored_policy.name
        guidance = stored_policy.guidance
        requester = gl.message.sender_address
        tx_context = context[:MAX_CONTEXT_CHARS]

        def leader_fn() -> dict:
            try:
                page = gl.nondet.web.render(source_url, mode="text")
            except Exception as exc:
                raise gl.vm.UserError(ERROR_TRANSIENT + ":rules_unreachable:" + str(exc))

            if isinstance(page, (bytes, bytearray)):
                page_text = page.decode("utf-8", "replace")
            else:
                page_text = str(page)

            if not page_text.strip():
                raise gl.vm.UserError(ERROR_EXTERNAL + ":empty_rules_page")

            rules_excerpt = page_text[:MAX_RULES_CHARS]

            prompt = f"""{COMPLIANCE_MARKER}
You are a compliance analyst. Decide whether the transaction below is allowed
by the rules fetched from the policy source, and score its residual risk.

Policy: {policy_name}
Analyst guidance: {guidance}
Rules source: {source_url}

Rules text:
<rules>
{rules_excerpt}
</rules>

Transaction under review:
- subject: {subject}
- counterparty: {counterparty}
- amount: {amount}
- context: {tx_context}

Respond with JSON only, nothing else:
{{
  "verdict": "COMPLIANT" or "NON_COMPLIANT" or "REVIEW",
  "risk_score": integer between 0 and 100,
  "findings": "one or two sentences naming the rule that drove the decision"
}}

Decision rules:
- COMPLIANT only when the fetched rules clearly allow the transaction.
- NON_COMPLIANT when a rule clearly prohibits or restricts it.
- REVIEW when the rules are silent, ambiguous, or the evidence is insufficient.
- risk_score 0 means no residual risk, 100 means maximal risk.
"""

            raw = gl.nondet.exec_prompt(prompt, response_format="json")
            return _build_verdict(raw)

        def validator_fn(leader_res) -> bool:
            leader_data = getattr(leader_res, "calldata", None)
            if not isinstance(leader_data, dict):
                return _agree_on_error(leader_res, leader_fn)

            try:
                own = leader_fn()
            except Exception:
                return False

            if leader_data.get("verdict") != own.get("verdict"):
                return False
            if leader_data.get("risk_band") != own.get("risk_band"):
                return False

            try:
                leader_score = int(leader_data.get("risk_score"))
                own_score = int(own.get("risk_score"))
            except (TypeError, ValueError):
                return False

            return abs(leader_score - own_score) <= RISK_SCORE_TOLERANCE

        verdict = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

        if not isinstance(verdict, dict):
            raise gl.vm.UserError(ERROR_LLM + ":unexpected_result")

        score = _clamp_score(verdict.get("risk_score", 50))

        self.next_assessment_id += 1
        assessment_id = "ca-" + str(self.next_assessment_id)

        self.assessments[assessment_id] = Assessment(
            policy_id=policy_id,
            subject=subject,
            counterparty=counterparty,
            amount=amount,
            context=tx_context,
            verdict=str(verdict.get("verdict", DECISION_REVIEW)),
            risk_score=u32(score),
            risk_band=str(verdict.get("risk_band", _risk_band(score))),
            findings=str(verdict.get("findings", "")),
            requester=requester,
            created_at=self._now(),
        )
        self.assessment_ids.append(assessment_id)
        self.policies[policy_id].assessments += 1

        return assessment_id

    # ------------------------------------------------------------------
    # views
    # ------------------------------------------------------------------

    @gl.public.view
    def get_owner(self) -> str:
        return self.owner.as_hex

    @gl.public.view
    def get_policy(self, policy_id: str) -> dict:
        if policy_id not in self.policies:
            raise gl.vm.UserError(ERROR_EXPECTED + ":unknown_policy")
        return _policy_to_dict(policy_id, self.policies[policy_id])

    @gl.public.view
    def get_policies(self) -> dict:
        return {key: _policy_to_dict(key, value) for key, value in self.policies.items()}

    @gl.public.view
    def get_assessment(self, assessment_id: str) -> dict:
        if assessment_id not in self.assessments:
            raise gl.vm.UserError(ERROR_EXPECTED + ":unknown_assessment")
        return _assessment_to_dict(assessment_id, self.assessments[assessment_id])

    @gl.public.view
    def get_assessments(self) -> dict:
        return {
            key: _assessment_to_dict(key, value) for key, value in self.assessments.items()
        }

    @gl.public.view
    def get_assessment_ids(self) -> dict:
        return {"ids": [assessment_id for assessment_id in self.assessment_ids]}

    @gl.public.view
    def get_summary(self) -> dict:
        total = 0
        compliant = 0
        non_compliant = 0
        review = 0
        high_risk = 0

        for assessment_id in self.assessment_ids:
            assessment = self.assessments[assessment_id]
            total += 1
            if assessment.verdict == DECISION_COMPLIANT:
                compliant += 1
            elif assessment.verdict == DECISION_NON_COMPLIANT:
                non_compliant += 1
            else:
                review += 1
            if assessment.risk_band == BAND_HIGH:
                high_risk += 1

        return {
            "total": total,
            "compliant": compliant,
            "non_compliant": non_compliant,
            "review": review,
            "high_risk": high_risk,
            "policies": self.policy_count,
        }
