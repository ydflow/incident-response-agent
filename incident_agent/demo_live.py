"""Run one real Pi/LLM incident investigation and preserve its full event trail."""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .events import AgentEvent, JsonlEventStore
from .models import Incident
from .state_machine import IncidentLifecycle, IncidentStatus

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"INC-001", "INC-011", "INC-012"}:
        raise SystemExit("usage: python -m incident_agent.demo_live INC-001|INC-011|INC-012")
    incident_id = sys.argv[1]
    fixture_path = ROOT / "incident_agent" / "fixtures" / incident_id / "incident.json"
    incident = Incident.model_validate_json(fixture_path.read_text(encoding="utf-8"))
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8]
    run_dir = ROOT / "data" / "incident-e2e" / f"{incident_id}-{run_id}"
    jsonl_file = run_dir / f"{incident_id}.jsonl"
    events = JsonlEventStore(jsonl_file)
    lifecycle = IncidentLifecycle(incident, events)
    lifecycle.transition_to(IncidentStatus.INVESTIGATING)
    result: dict[str, object] | None = None
    failure: str | None = None
    try:
        run = subprocess.run(
            ["node", "--import", "tsx", "scripts/demo-incident-live.ts", incident_id],
            cwd=ROOT,
            env={**os.environ, "MINICLAW_INCIDENT_RUNS_DIR": str(run_dir)},
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=240,
            check=False,
        )
        if run.returncode:
            # Provider errors can contain secrets. Never echo raw stderr.
            failure = "live_runner_failed"
        else:
            result = json.loads(run.stdout)
            if result.get("incident_id") != incident_id or not isinstance(result.get("events"), list):
                raise ValueError("invalid_runner_result")
            events.extend(result["events"], incident_id)
            if result.get("runtime_error"):
                failure = str(result["runtime_error"])
            elif not result.get("decision_valid"):
                failure = "invalid_or_unsubstantiated_model_decision"
            else:
                decision = result["decision"]
                if not isinstance(decision, dict):
                    raise ValueError("invalid_decision")
                if decision["decision"] == "escalate":
                    lifecycle.transition_to(IncidentStatus.ESCALATED)
                else:
                    lifecycle.transition_to(IncidentStatus.DIAGNOSED)
                    if any(event.event_type.value == "ApprovalRequested" for event in events.snapshot()):
                        lifecycle.transition_to(IncidentStatus.AWAITING_APPROVAL)
    except subprocess.TimeoutExpired:
        failure = "live_runner_timed_out"
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        failure = "invalid_runner_result"
    if failure:
        lifecycle.transition_to(IncidentStatus.FAILED)
    timeline = events.snapshot()
    persisted = [AgentEvent.model_validate_json(line) for line in jsonl_file.read_text(encoding="utf-8").splitlines()]
    if [event.event_id for event in persisted] != [event.event_id for event in timeline]:
        raise RuntimeError("JSONL event order or contents differ from the live timeline")
    if result and result.get("executor_called"):
        raise RuntimeError("remediation executor was called without approval")
    if any(event.event_type.value == "ActionExecuted" for event in timeline):
        raise RuntimeError("unapproved remediation was executed")
    output = {
        "incident_id": incident_id,
        "run_id": run_id,
        "jsonl_file": str(jsonl_file),
        "final_status": lifecycle.status.value,
        "failure": failure,
        "tool_calls": result.get("tool_calls", []) if result else [],
        "collected_evidence": result.get("collected_evidence", []) if result else [],
        "final_text": result.get("final_text", "") if result else "",
        "decision": result.get("decision") if result else None,
        "decision_valid": result.get("decision_valid", False) if result else False,
        "model": result.get("model") if result else None,
        "executor_called": result.get("executor_called", False) if result else False,
        "events": [event.model_dump(mode="json") for event in timeline],
    }
    snapshot = run_dir / "run.json"
    snapshot.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "incident_id": incident_id,
        "run_json": str(snapshot),
        "jsonl_file": str(jsonl_file),
        "final_status": lifecycle.status.value,
        "failure": failure,
        "tool_calls": output["tool_calls"],
        "evidence_ids": [e["evidence_id"] for e in output["collected_evidence"]],
        "decision": output["decision"],
        "event_types": [event.event_type.value for event in timeline],
        "executor_called": output["executor_called"],
    }, ensure_ascii=False, indent=2))
    return 0 if not failure else 1


if __name__ == "__main__":
    raise SystemExit(main())
