"""Three acceptance checks against the recorded INC-001 AgentEvent trace."""

import json
import socket
import subprocess
from pathlib import Path

import pytest

from incident_agent.events import JsonlEventStore
from incident_agent.replay import load_events, reconstruct_runs, render_replay
from incident_agent.state_machine import IncidentLifecycle, IncidentStatus


pytestmark = pytest.mark.core


TRACE = Path(__file__).with_name("fixtures") / "INC-001.jsonl"


def test_inc001_jsonl_replays_complete_history() -> None:
    before = TRACE.read_bytes()

    runs = reconstruct_runs(load_events("INC-001", TRACE.parent))

    assert TRACE.read_bytes() == before
    assert len(runs) == 1
    run = runs[0]
    assert len(run.timeline) == 22
    assert run.status == IncidentStatus.ESCALATED
    assert len(run.evidence_ids) == 4
    assert run.diagnosis is not None
    assert list(run.approvals.values()) == ["reject"]
    assert run.executed_actions == []
    assert run.warnings == []
    assert "Final status: ESCALATED" in render_replay("INC-001", runs)


def test_replay_order_matches_recorded_trace() -> None:
    original = [json.loads(line) for line in TRACE.read_text(encoding="utf-8").splitlines()]
    run = reconstruct_runs(load_events("INC-001", TRACE.parent))[0]

    replayed_types = [line.split(" ", 2)[1] for line in run.timeline]
    assert replayed_types == [event["event_type"] for event in original]
    assert [call.name for call in run.tool_calls.values()] == [
        event["payload"]["tool"]
        for event in original
        if event["event_type"] == "ToolCalled"
    ]
    assert run.evidence_ids == [
        event["payload"]["evidence_id"]
        for event in original
        if event["event_type"] == "EvidenceCollected"
    ]


def test_replay_never_calls_llm_tools_or_remediation_executor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempted: list[str] = []

    def forbidden(name: str):
        def fail(*args: object, **kwargs: object) -> None:
            attempted.append(name)
            raise AssertionError(f"Replay attempted a live operation: {name}")

        return fail

    # The live MiniClaw/Tool/Executor path runs in Node; any attempt to start
    # it, contact an LLM endpoint, or mutate the lifecycle fails this test.
    monkeypatch.setattr(subprocess, "run", forbidden("subprocess.run"))
    monkeypatch.setattr(subprocess, "Popen", forbidden("subprocess.Popen"))
    monkeypatch.setattr(socket.socket, "connect", forbidden("socket.connect"))
    monkeypatch.setattr(socket, "create_connection", forbidden("socket.create_connection"))
    monkeypatch.setattr(IncidentLifecycle, "transition_to", forbidden("transition_to"))
    monkeypatch.setattr(JsonlEventStore, "_persist", forbidden("JsonlEventStore._persist"))

    before = TRACE.read_bytes()
    runs = reconstruct_runs(load_events("INC-001", TRACE.parent))
    output = render_replay("INC-001", runs)

    assert len(runs[0].timeline) == 22
    assert "ApprovalDecided reject" in output
    assert "Actions executed: 0" in output
    assert TRACE.read_bytes() == before
    assert attempted == []
