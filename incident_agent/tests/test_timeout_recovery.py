"""Three real Pi ToolCall timeout cases; prior Evidence must survive."""

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest

from incident_agent import Incident, IncidentLifecycle, IncidentStatus, JsonlEventStore


pytestmark = pytest.mark.core


ROOT = Path(__file__).resolve().parents[2]
HARNESS = Path(__file__).with_name("timeout_recovery_harness.ts")


def assert_timeout_keeps_incident_and_evidence(target: str, tmp_path: Path) -> None:
    run_dir = tmp_path / "runs"
    jsonl_file = run_dir / "INC-001.jsonl"
    lifecycle = IncidentLifecycle(
        Incident(
            incident_id="INC-001",
            service="payment-service",
            alert="5xx spike",
            started_at=datetime.now(timezone.utc),
        ),
        JsonlEventStore(jsonl_file),
    )
    lifecycle.transition_to(IncidentStatus.INVESTIGATING)

    completed = subprocess.run(
        ["node", "--import", "tsx", str(HARNESS), target, str(run_dir)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)

    # A: The ToolCall returns an explicit, machine-readable timeout.
    assert result["target"] == target
    assert result["timeout_result"]["error"] == "tool_timeout"
    assert result["timeout_result"]["tool"] == target
    assert result["timeout_result"]["timeout_ms"] == 20

    # B/C: JSONL contains the failure event and its reason, not just a message.
    lines = jsonl_file.read_text(encoding="utf-8").splitlines()
    events = [json.loads(line) for line in lines]
    failed = [
        event
        for event in events
        if event["event_type"] == "ToolFailed"
        and event["payload"].get("tool_call_id") == "forced-timeout"
    ]
    assert len(failed) == 1
    assert failed[0]["payload"]["tool"] == target
    assert failed[0]["payload"]["reason"] == "tool_timeout"
    assert failed[0]["payload"]["timeout_ms"] == 20
    assert target in failed[0]["payload"]["message"]
    assert any(
        event["event_type"] == "ToolResult"
        and event["payload"].get("tool_call_id") == "forced-timeout"
        and event["payload"].get("status") == "timeout"
        for event in events
    )

    # D/E: The earlier Evidence is still present, and the same session can
    # collect another item without resetting the incident or its event history.
    assert result["before_evidence_id"] == "INC-001:git_diff"
    assert result["prior_event_ids_preserved"] is True
    assert result["previous_evidence_content_preserved"] is True
    assert result["session_continued"] is True
    assert lifecycle.status == IncidentStatus.INVESTIGATING
    assert [
        event["payload"]["evidence_id"]
        for event in events
        if event["event_type"] == "EvidenceCollected"
    ] == [result["before_evidence_id"], result["after_evidence_id"]]
    assert result["retained_evidence_ids"] == [
        result["before_evidence_id"],
        result["after_evidence_id"],
    ]
    assert not any(
        event["event_type"] == "EvidenceCollected"
        and event["payload"].get("tool_call_id") == "forced-timeout"
        for event in events
    )


def test_query_logs_timeout_keeps_prior_evidence(tmp_path: Path) -> None:
    assert_timeout_keeps_incident_and_evidence("query_logs", tmp_path)


def test_query_metrics_timeout_keeps_prior_evidence(tmp_path: Path) -> None:
    assert_timeout_keeps_incident_and_evidence("query_metrics", tmp_path)


def test_query_trace_timeout_keeps_prior_evidence(tmp_path: Path) -> None:
    assert_timeout_keeps_incident_and_evidence("query_trace", tmp_path)
