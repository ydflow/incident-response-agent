"""New thin adapter must continue using original lifecycle and Replay validation."""
from datetime import datetime, timezone
from uuid import uuid4
import pytest
from incident_agent.live_investigation import execute
from incident_agent.state_machine import IncidentStatus, is_legal_transition

def incident():
    return dict(incident_id=f"LIVE-{uuid4()}", service="orders", alert="Pool timeout", started_at=datetime.now(timezone.utc).isoformat())

def test_contract_is_original_state_machine():
    assert execute({"action": "contract"}) == {s.value: [t.value for t in IncidentStatus if is_legal_transition(s, t)] for s in IncidentStatus}

def test_live_start_and_escalate_replay_legal_path():
    value=incident()
    started=execute({"action":"start","incident":value})
    assert started["status"] == "INVESTIGATING"
    result=execute({"action":"escalate","incident":value,"events":started["events"]})
    assert result["status"] == "ESCALATED"
    assert [e["event_type"] for e in result["events"]] == ["StatusChanged"]
    with pytest.raises(ValueError):
        execute({"action":"escalate","incident":value,"events":started["events"]+result["events"]})

def test_foreign_history_and_uncollected_diagnosis_fail_closed():
    value=incident();start=execute({"action":"start","incident":value})
    with pytest.raises(ValueError):
        execute({"action":"escalate","incident":incident(),"events":start["events"]})
    with pytest.raises(ValueError):
        execute({"action":"diagnose","incident":value,"events":start["events"],"evidence":[],"diagnosis":dict(incident_id=value["incident_id"],root_cause="Claim",confidence=1.0,evidence_ids=["unknown"],recommendation="Review")})
