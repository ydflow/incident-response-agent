"""Replay reads recorded events; it never runs the incident workflow again."""

from pathlib import Path

import pytest

from incident_agent.events import EventType, JsonlEventStore
from incident_agent.replay import (
    ReplayLoadError,
    ReplayOrderError,
    load_events,
    reconstruct_runs,
    render_replay,
)
from incident_agent.state_machine import IncidentStatus


def _store(tmp_path: Path) -> JsonlEventStore:
    return JsonlEventStore(tmp_path / "INC-001.jsonl")


def _write_rejected_run(store: JsonlEventStore) -> None:
    incident = "INC-001"
    store.emit(incident, EventType.INCIDENT_CREATED, {"status": "RECEIVED"})
    store.emit(
        incident,
        EventType.STATUS_CHANGED,
        {"from": "RECEIVED", "to": "INVESTIGATING"},
    )
    store.emit(
        incident, EventType.TOOL_CALLED, {"tool": "query_logs", "tool_call_id": "c1"}
    )
    store.emit(
        incident,
        EventType.TOOL_RESULT,
        {"tool": "query_logs", "tool_call_id": "c1", "status": "returned"},
    )
    store.emit(
        incident,
        EventType.EVIDENCE_COLLECTED,
        {"tool": "query_logs", "tool_call_id": "c1", "evidence_id": "e1"},
    )
    store.emit(incident, EventType.DIAGNOSIS_CREATED, {"evidence_ids": ["e1"]})
    store.emit(
        incident,
        EventType.STATUS_CHANGED,
        {"from": "INVESTIGATING", "to": "DIAGNOSED"},
    )
    store.emit(
        incident,
        EventType.TOOL_CALLED,
        {"tool": "rollback_config", "tool_call_id": "c2"},
    )
    store.emit(
        incident,
        EventType.APPROVAL_REQUESTED,
        {"approval_id": "a1", "action": "rollback_config"},
    )
    store.emit(
        incident,
        EventType.TOOL_RESULT,
        {"tool": "rollback_config", "tool_call_id": "c2", "status": "returned"},
    )
    store.emit(
        incident,
        EventType.STATUS_CHANGED,
        {"from": "DIAGNOSED", "to": "AWAITING_APPROVAL"},
    )
    store.emit(
        incident,
        EventType.APPROVAL_DECIDED,
        {"approval_id": "a1", "decision": "reject"},
    )
    store.emit(
        incident,
        EventType.STATUS_CHANGED,
        {"from": "AWAITING_APPROVAL", "to": "ESCALATED"},
    )


def test_replay_reconstructs_reject_without_modifying_jsonl(tmp_path: Path) -> None:
    store = _store(tmp_path)
    _write_rejected_run(store)
    original = store.file_path.read_bytes()

    runs = reconstruct_runs(load_events("INC-001", tmp_path))

    assert store.file_path.read_bytes() == original
    assert len(runs) == 1
    assert runs[0].status == IncidentStatus.ESCALATED
    assert runs[0].evidence_ids == ["e1"]
    assert runs[0].approvals == {"a1": "reject"}
    assert runs[0].executed_actions == []
    assert "ApprovalDecided reject" in render_replay("INC-001", runs)


def test_replay_separates_two_appended_runs(tmp_path: Path) -> None:
    store = _store(tmp_path)
    _write_rejected_run(store)
    _write_rejected_run(_store(tmp_path))

    runs = reconstruct_runs(load_events("INC-001", tmp_path))

    assert len(runs) == 2
    assert [run.status for run in runs] == [
        IncidentStatus.ESCALATED,
        IncidentStatus.ESCALATED,
    ]
    assert all(len(run.timeline) == 13 for run in runs)


def test_replay_reports_corrupted_jsonl_line(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.emit("INC-001", EventType.INCIDENT_CREATED, {"status": "RECEIVED"})
    with store.file_path.open("a", encoding="utf-8") as stream:
        stream.write('{"event_id": broken\n')

    with pytest.raises(ReplayLoadError, match="line 2: invalid JSON"):
        load_events("INC-001", tmp_path)


def test_replay_rejects_tool_result_before_call(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.emit("INC-001", EventType.INCIDENT_CREATED, {"status": "RECEIVED"})
    store.emit(
        "INC-001",
        EventType.TOOL_RESULT,
        {"tool": "query_logs", "tool_call_id": "missing", "status": "returned"},
    )

    with pytest.raises(ReplayOrderError, match="line 2: ToolResult"):
        reconstruct_runs(load_events("INC-001", tmp_path))


def test_replay_rejects_illegal_status_jump(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.emit("INC-001", EventType.INCIDENT_CREATED, {"status": "RECEIVED"})
    store.emit(
        "INC-001",
        EventType.STATUS_CHANGED,
        {"from": "RECEIVED", "to": "RESOLVED"},
    )

    with pytest.raises(ReplayOrderError, match="invalid StatusChanged"):
        reconstruct_runs(load_events("INC-001", tmp_path))


def test_replay_never_accepts_execution_after_reject(tmp_path: Path) -> None:
    store = _store(tmp_path)
    _write_rejected_run(store)
    store.emit(
        "INC-001",
        EventType.ACTION_EXECUTED,
        {"approval_id": "a1", "action": "rollback_config"},
    )

    with pytest.raises(ReplayOrderError, match="ActionExecuted"):
        reconstruct_runs(load_events("INC-001", tmp_path))
