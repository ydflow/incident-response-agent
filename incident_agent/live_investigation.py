"""Thin, bounded host adapter using the original lifecycle/models/Replay.

No source reads, model, approvals, or tool calls. JSON input is private execution
transport; only newly produced legal lifecycle events are returned.
"""
import json
import sys

from .events import AgentEvent, EventType
from .models import Diagnosis, Evidence, Incident
from .replay import LoadedEvent, reconstruct_runs
from .state_machine import IncidentLifecycle, IncidentStatus, is_legal_transition


def execute(value: dict) -> dict:
    if value.get("action") == "contract":
        return {s.value: [t.value for t in IncidentStatus if is_legal_transition(s, t)] for s in IncidentStatus}
    incident = Incident.model_validate(value["incident"])
    lifecycle = IncidentLifecycle(incident)
    if value["action"] == "start":
        lifecycle.transition_to(IncidentStatus.INVESTIGATING)
        return {"status": lifecycle.status.value, "events": [e.model_dump(mode="json") for e in lifecycle.events.snapshot()]}
    historical = tuple(LoadedEvent(i + 1, AgentEvent.model_validate(e)) for i, e in enumerate(value["events"]))
    if any(e.event.incident_id != incident.incident_id for e in historical):
        raise ValueError("foreign incident")
    runs = reconstruct_runs(historical)
    if len(runs) != 1:
        raise ValueError("adapter accepts one run")
    for loaded in historical:
        if loaded.event.event_type == EventType.STATUS_CHANGED:
            lifecycle.transition_to(IncidentStatus(loaded.event.payload["to"]))
    if lifecycle.status != runs[0].status:
        raise ValueError("lifecycle/replay mismatch")
    before = len(lifecycle.events.snapshot())
    if value["action"] == "diagnose":
        diagnosis = Diagnosis.model_validate(value["diagnosis"])
        evidence = tuple(Evidence.model_validate(e) for e in value["evidence"])
        collected = {e.evidence_id for e in evidence if e.incident_id == incident.incident_id}
        if diagnosis.incident_id != incident.incident_id or not set(diagnosis.evidence_ids).issubset(collected & set(runs[0].evidence_ids)):
            raise ValueError("uncollected diagnosis references")
        lifecycle.events.emit(incident.incident_id, EventType.DIAGNOSIS_CREATED, {
            "evidence_ids": diagnosis.evidence_ids, "confidence": diagnosis.confidence,
            "root_cause": diagnosis.root_cause,
        })
        lifecycle.transition_to(IncidentStatus.DIAGNOSED)
    elif value["action"] == "escalate":
        lifecycle.transition_to(IncidentStatus.ESCALATED)
    elif value["action"] == "fail":
        lifecycle.transition_to(IncidentStatus.FAILED)
    else:
        raise ValueError("unknown action")
    return {"status": lifecycle.status.value, "events": [e.model_dump(mode="json") for e in lifecycle.events.snapshot()[before:]]}


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(1_048_577)
        if len(raw) > 1_048_576:
            raise ValueError("input bound")
        result = execute(json.loads(raw))
        encoded = json.dumps(result, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > 131_072:
            raise ValueError("output bound")
        print(encoded)
        return 0
    except Exception:
        print('{"error":"lifecycle_validation_failed"}')
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
