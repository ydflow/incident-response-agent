"""Lifecycle events must describe actual, legal transitions."""

import json
from datetime import datetime, timezone

import pytest

from incident_agent import (
    EventType,
    InMemoryEventStore,
    JsonlEventStore,
    Incident,
    IncidentLifecycle,
    IncidentStatus,
    InvalidTransitionError,
)


def incident() -> Incident:
    return Incident(
        incident_id="INC-001",
        service="payment-service",
        alert="5xx spike",
        started_at=datetime.now(timezone.utc),
    )


def test_creation_and_legal_transition_emit_serializable_events() -> None:
    events = InMemoryEventStore()
    lifecycle = IncidentLifecycle(incident(), events)
    lifecycle.transition_to(IncidentStatus.INVESTIGATING)

    timeline = events.snapshot()
    assert [event.event_type for event in timeline] == [
        EventType.INCIDENT_CREATED,
        EventType.STATUS_CHANGED,
    ]
    assert timeline[1].payload == {"from": "RECEIVED", "to": "INVESTIGATING"}
    assert json.loads(timeline[1].model_dump_json())["incident_id"] == "INC-001"


def test_illegal_transition_never_emits_status_changed() -> None:
    events = InMemoryEventStore()
    lifecycle = IncidentLifecycle(incident(), events)

    with pytest.raises(InvalidTransitionError):
        lifecycle.transition_to(IncidentStatus.RESOLVED)

    assert lifecycle.status == IncidentStatus.RECEIVED
    assert [event.event_type for event in events.snapshot()] == [
        EventType.INCIDENT_CREATED
    ]


def test_runner_events_are_validated_before_collection() -> None:
    events = InMemoryEventStore()
    with pytest.raises(ValueError, match="incident_id"):
        events.extend(
            [
                {
                    "event_id": "302c0112-6956-4374-a278-d82b18868d1e",
                    "incident_id": "INC-999",
                    "event_type": "ToolCalled",
                    "timestamp": "2026-09-26T00:00:00Z",
                    "payload": {"tool": "query_logs"},
                }
            ],
            "INC-001",
        )
    assert events.snapshot() == ()


def test_jsonl_store_appends_without_overwriting_and_each_line_loads(tmp_path) -> None:
    file_path = tmp_path / "runs" / "INC-001.jsonl"
    first = JsonlEventStore(file_path).emit(
        "INC-001", EventType.INCIDENT_CREATED, {"status": "RECEIVED"}
    )
    second = JsonlEventStore(file_path).emit(
        "INC-001", EventType.STATUS_CHANGED, {"from": "RECEIVED", "to": "INVESTIGATING"}
    )

    lines = file_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    assert [json.loads(line)["event_id"] for line in lines] == [
        str(first.event_id),
        str(second.event_id),
    ]
    assert [json.loads(line)["event_type"] for line in lines] == [
        "IncidentCreated",
        "StatusChanged",
    ]
