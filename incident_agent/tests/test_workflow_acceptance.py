"""Twelve deterministic end-to-end investigation acceptance cases.

The scripted planner reads only returned Evidence. MiniClaw's real read-only
ToolCalls, SAFE policy, Evidence collection and AgentEvents run in Node; the
Python workflow owns Incident state and the final decision boundary.
"""

import json
import subprocess
from pathlib import Path

import pytest

from incident_agent import Diagnosis, Evidence, EventType, Incident, IncidentStatus
from incident_agent.workflow import Escalation, InvestigationWorkflow, ToolBatch


pytestmark = pytest.mark.core

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "incident_agent" / "fixtures"
HARNESS = Path(__file__).with_name("workflow_tool_harness.ts")
GROUND_TRUTH = json.loads((ROOT / "evaluation" / "expected_cases.json").read_text(encoding="utf-8"))


class MiniClawToolGateway:
    def collect(self, incident_id: str) -> ToolBatch:
        completed = subprocess.run(
            ["node", "--import", "tsx", str(HARNESS), incident_id],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
            check=False,
        )
        assert completed.returncode == 0, completed.stderr
        payload = json.loads(completed.stdout)
        return ToolBatch(
            evidence=tuple(Evidence.model_validate(item) for item in payload["evidence"]),
            events=tuple(payload["events"]),
        )


class ScriptedEvidencePlanner:
    """A fake model using observable signals, never an incident-ID answer map."""

    def __init__(self) -> None:
        self.cause_code: str | None = None

    def plan(self, incident: Incident, evidence: tuple[Evidence, ...]) -> Diagnosis | Escalation:
        by_source = {item.source: item for item in evidence}
        logs = json.loads(by_source["logs"].content)
        metrics = json.loads(by_source["metrics"].content)
        traces = json.loads(by_source["trace"].content)
        patch = by_source["git_diff"].content
        log_text = " ".join(str(item["message"]) for item in logs).lower()
        latest = metrics[-1]
        spans = [span for trace in traces for span in trace["spans"]]

        if not traces:
            return Escalation("EVIDENCE_INSUFFICIENT: worker failure has no causal trace")
        for trace in traces:
            same_request_logs = [entry for entry in logs if entry["request_id"] == trace["request_id"]]
            for span in trace["spans"]:
                if span.get("status") == "OK" and any(
                    "cache timeout" in entry["message"].lower()
                    and span["span_id"] in entry["message"]
                    for entry in same_request_logs
                ):
                    return Escalation("EVIDENCE_CONFLICT: log and trace disagree for the same span")

        cause: tuple[str, str, tuple[str, ...]] | None = None
        if "max_connections: 5" in patch and latest.get("db_pool_waiting_requests", 0) > 0:
            cause = ("DB_POOL_CONFIG", "Database connection acquisition exhausted the reduced pool", ("metrics", "trace", "git_diff"))
        elif "cache connect refused" in log_text and any(s["name"] == "redis.get" and s["status"] == "ERROR" for s in spans):
            cause = ("REDIS_UNAVAILABLE", "Redis connection refusal prevented session reads", ("logs", "trace"))
        elif any(s["name"] == "shipping-api" and s.get("http_status") == 503 for s in spans):
            cause = ("UPSTREAM_5XX", "shipping-api returned HTTP 503 to checkout", ("logs", "trace", "metrics"))
        elif "coupon = request['coupon']" in patch and "missing-field" in log_text:
            cause = ("DEPLOYMENT_REGRESSION", "The new coupon field access fails on legacy requests", ("logs", "trace", "git_diff"))
        elif "interval_seconds: 1" in patch and latest.get("cpu_percent", 0) > 90:
            cause = ("CPU_SCHEDULER", "Overlapping statistics jobs saturated CPU", ("logs", "metrics", "git_diff"))
        elif "processed_buffers.append" in patch and latest.get("memory_mb", 0) > 1700:
            cause = ("MEMORY_RETENTION", "Processed image buffers accumulated in memory", ("metrics", "git_diff"))
        elif "sms.sandbox.example.invalid" in patch and any(s.get("http_status") == 401 for s in spans):
            cause = ("ENV_ENDPOINT", "The production SMS client called the sandbox endpoint", ("logs", "trace", "git_diff"))
        elif "ttl_seconds: 1" in patch and latest.get("cache_hit_percent", 100) < 20:
            cause = ("CACHE_TTL", "A one-second TTL caused repeated cache misses", ("metrics", "trace", "git_diff"))
        elif "DROP INDEX idx_orders_customer_id" in patch and latest.get("db_query_p95_ms", 0) > 1000:
            cause = ("DB_SLOW_QUERY", "The order search query slowed after its index was removed", ("metrics", "trace", "git_diff"))
        elif latest.get("dns_lookup_p95_ms", 0) > 1000 and any(s["name"].startswith("dns.lookup") and s["status"] == "ERROR" for s in spans):
            cause = ("DNS_LATENCY", "Slow DNS resolution delayed avatar-api calls", ("logs", "metrics", "trace"))

        if cause is None:
            return Escalation("EVIDENCE_INSUFFICIENT: no supported causal pattern")
        self.cause_code, explanation, sources = cause
        return Diagnosis(
            incident_id=incident.incident_id,
            root_cause=explanation,
            confidence=0.85,
            evidence_ids=[by_source[source].evidence_id for source in sources],
            recommendation="Review the cited evidence before proposing a gated remediation.",
        )


CASES = [
    ("INC-001", "DB_POOL_CONFIG", IncidentStatus.DIAGNOSED),
    ("INC-002", "REDIS_UNAVAILABLE", IncidentStatus.DIAGNOSED),
    ("INC-003", "UPSTREAM_5XX", IncidentStatus.DIAGNOSED),
    ("INC-004", "DEPLOYMENT_REGRESSION", IncidentStatus.DIAGNOSED),
    ("INC-005", "CPU_SCHEDULER", IncidentStatus.DIAGNOSED),
    ("INC-006", "MEMORY_RETENTION", IncidentStatus.DIAGNOSED),
    ("INC-007", "ENV_ENDPOINT", IncidentStatus.DIAGNOSED),
    ("INC-008", "CACHE_TTL", IncidentStatus.DIAGNOSED),
    ("INC-009", "DB_SLOW_QUERY", IncidentStatus.DIAGNOSED),
    ("INC-010", "DNS_LATENCY", IncidentStatus.DIAGNOSED),
    ("INC-011", None, IncidentStatus.ESCALATED),
    ("INC-012", None, IncidentStatus.ESCALATED),
]


@pytest.mark.parametrize(("incident_id", "expected_code", "expected_status"), CASES)
def test_case_workflow_acceptance(
    incident_id: str, expected_code: str | None, expected_status: IncidentStatus
) -> None:
    expected = GROUND_TRUTH[incident_id]
    assert expected["expected_status"] == expected_status.value
    assert isinstance(expected["expected_root_cause"], str) and expected["expected_root_cause"]
    fixture = FIXTURES / incident_id
    incident_data = json.loads((fixture / "incident.json").read_text(encoding="utf-8"))
    assert set(incident_data) == {"incident_id", "service", "alert", "started_at"}
    incident = Incident.model_validate(incident_data)
    assert incident.incident_id == incident_id

    planner = ScriptedEvidencePlanner()
    result = InvestigationWorkflow(MiniClawToolGateway(), planner).run(incident)
    assert result.status == expected_status
    assert planner.cause_code == expected_code
    for item in result.evidence:
        assert all(
            key not in item.content
            for key in ("expected_root_cause", "correct_answer", "ground_truth", "expected_status")
        )
    assert {item.source for item in result.evidence} == {"logs", "metrics", "trace", "git_diff"}
    assert len(result.evidence) == 4
    for item in result.evidence:
        source_file = "git_diff.patch" if item.source == "git_diff" else f"{item.source}.json"
        raw = (fixture / source_file).read_text(encoding="utf-8")
        if item.source == "git_diff":
            assert item.content.replace("\r\n", "\n") == raw.strip()
        else:
            key = {"logs": "entries", "metrics": "samples", "trace": "traces"}[item.source]
            assert json.loads(item.content) == json.loads(raw)[key]

    types = [event.event_type for event in result.events]
    assert types[0] == EventType.INCIDENT_CREATED
    assert types.count(EventType.TOOL_CALLED) == 4
    assert types.count(EventType.TOOL_RESULT) == 4
    assert types.count(EventType.EVIDENCE_COLLECTED) == 4
    assert EventType.TOOL_FAILED not in types
    assert EventType.APPROVAL_REQUESTED not in types
    assert EventType.ACTION_EXECUTED not in types
    assert result.events[-1].event_type == EventType.STATUS_CHANGED
    assert result.events[-1].payload["to"] == expected_status.value

    if expected_status == IncidentStatus.DIAGNOSED:
        assert result.diagnosis is not None
        assert result.diagnosis.evidence_ids
        assert set(result.diagnosis.evidence_ids).issubset(
            {item.evidence_id for item in result.evidence}
        )
        assert types.count(EventType.DIAGNOSIS_CREATED) == 1
        assert types.index(EventType.DIAGNOSIS_CREATED) > max(
            i for i, event_type in enumerate(types) if event_type == EventType.EVIDENCE_COLLECTED
        )
        assert result.escalation_reason is None
    else:
        assert result.diagnosis is None
        assert EventType.DIAGNOSIS_CREATED not in types
        assert result.escalation_reason
        if incident_id == "INC-011":
            assert result.escalation_reason.startswith("EVIDENCE_CONFLICT")
            logs = json.loads(next(e.content for e in result.evidence if e.source == "logs"))
            metrics = json.loads(next(e.content for e in result.evidence if e.source == "metrics"))
            traces = json.loads(next(e.content for e in result.evidence if e.source == "trace"))
            conflicting = next(t for t in traces if t["request_id"] == "req-conflict-11")
            assert any(
                line["request_id"] == "req-conflict-11"
                and "cache timeout" in line["message"]
                and "cache-get-10" in line["message"]
                for line in logs
            )
            assert any(s["span_id"] == "cache-get-10" and s["status"] == "OK" for s in conflicting["spans"])
            assert any(s["name"] == "shipping-api" and s["http_status"] == 503 for s in conflicting["spans"])
            assert metrics[-1]["cache_error_percent"] > 0
            assert metrics[-1]["shipping_5xx_percent"] > 0
        if incident_id == "INC-012":
            assert result.escalation_reason.startswith("EVIDENCE_INSUFFICIENT")
            logs = json.loads(next(e.content for e in result.evidence if e.source == "logs"))
            metrics = json.loads(next(e.content for e in result.evidence if e.source == "metrics"))
            assert json.loads(next(e.content for e in result.evidence if e.source == "trace")) == []
            assert all(line["message"] == "job failed; retry scheduled" for line in logs)
            assert metrics[-1]["pending_jobs"] > metrics[0]["pending_jobs"]
            assert "No relevant code or configuration change" in next(
                e.content for e in result.evidence if e.source == "git_diff"
            )
            assert not any("disk" in e.content.lower() for e in result.evidence)
