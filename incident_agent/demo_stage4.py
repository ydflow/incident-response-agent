"""Run INC-001 through the real Pi investigation and a rejected ToolCall."""

import json
import os
import subprocess
from pathlib import Path

from .events import AgentEvent, JsonlEventStore
from .models import Incident
from .state_machine import IncidentLifecycle, IncidentStatus


ROOT = Path(__file__).resolve().parent.parent
INCIDENT_ID = "INC-001"


def _read_message(line: str, phase: str) -> dict[str, object]:
    if not line:
        raise RuntimeError(f"{phase} produced no result")
    message = json.loads(line)
    if not isinstance(message, dict):
        raise RuntimeError(f"{phase} result must be an object")
    return message


def main() -> None:
    fixture = json.loads(
        (ROOT / "incident_agent/fixtures/INC-001/incident.json").read_text(
            encoding="utf-8"
        )
    )
    incident = Incident.model_validate(fixture)
    jsonl_file = ROOT / "data/incident-runs/INC-001.jsonl"
    original_bytes = jsonl_file.stat().st_size if jsonl_file.exists() else 0
    runner_env = {
        **os.environ,
        "MINICLAW_INCIDENT_RUNS_DIR": str(jsonl_file.parent),
    }
    events = JsonlEventStore(jsonl_file)
    lifecycle = IncidentLifecycle(incident, events)
    lifecycle.transition_to(IncidentStatus.INVESTIGATING)

    investigation = subprocess.run(
        ["node", "--import", "tsx", "scripts/demo-inc001.ts"],
        cwd=ROOT,
        env=runner_env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
        check=False,
    )
    if investigation.returncode:
        raise RuntimeError("INC-001 live investigation failed; no diagnosis recorded")
    result = _read_message(investigation.stdout, "investigation")
    if result.get("incident_id") != INCIDENT_ID:
        raise RuntimeError("investigation returned another incident")
    runner_events = result.get("events")
    if not isinstance(runner_events, list):
        raise RuntimeError("investigation produced no AgentEvent list")
    events.extend(runner_events, INCIDENT_ID)
    types = [event.event_type.value for event in events.snapshot()]
    if types.count("EvidenceCollected") != 4 or "DiagnosisCreated" not in types:
        raise RuntimeError("investigation did not collect four evidence items and a diagnosis")
    lifecycle.transition_to(IncidentStatus.DIAGNOSED)

    with subprocess.Popen(
        ["node", "--import", "tsx", "scripts/demo-inc001-reject.ts"],
        cwd=ROOT,
        env=runner_env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    ) as approval:
        assert approval.stdout is not None
        assert approval.stdin is not None
        requested = _read_message(approval.stdout.readline(), "approval request")
        if requested.get("phase") != "requested" or requested.get("executor_called"):
            raise RuntimeError("rollback request did not stop before the executor")
        request_events = requested.get("events")
        if not isinstance(request_events, list):
            raise RuntimeError("rollback request produced no AgentEvent list")
        events.extend(request_events, INCIDENT_ID)
        if not any(
            event.event_type.value == "ApprovalRequested"
            for event in events.snapshot()
        ):
            raise RuntimeError("approval request event was not recorded")
        lifecycle.transition_to(IncidentStatus.AWAITING_APPROVAL)
        approval.stdin.write("reject\n")
        approval.stdin.flush()
        rejected = _read_message(approval.stdout.readline(), "approval decision")
        if rejected.get("phase") != "rejected" or rejected.get("executor_called"):
            raise RuntimeError("reject did not preserve the executor boundary")
        decision_events = rejected.get("events")
        if not isinstance(decision_events, list):
            raise RuntimeError("reject produced no AgentEvent list")
        events.extend(decision_events, INCIDENT_ID)
        approval.stdin.close()
        approval.wait(timeout=30)
        if approval.returncode:
            raise RuntimeError("approval process failed")
    lifecycle.transition_to(IncidentStatus.ESCALATED)

    timeline = events.snapshot()
    if any(event.event_type.value == "ActionExecuted" for event in timeline):
        raise RuntimeError("rejected rollback was executed")
    # Check all lines, including previous runs, without changing or truncating them.
    all_lines = jsonl_file.read_bytes().splitlines(keepends=True)
    if any(not line.endswith(b"\n") for line in all_lines):
        raise RuntimeError("JSONL contains an incomplete event line")
    for line in all_lines:
        AgentEvent.model_validate(json.loads(line))
    with jsonl_file.open("rb") as stream:
        stream.seek(original_bytes)
        appended = [AgentEvent.model_validate(json.loads(line)) for line in stream]
    if [event.event_id for event in appended] != [
        event.event_id for event in timeline
    ]:
        raise RuntimeError("JSONL order does not match the in-memory event timeline")
    output = {
        "incident_id": INCIDENT_ID,
        "final_status": lifecycle.status.value,
        "rollback_executor_called": False,
        "jsonl_file": str(jsonl_file),
        "appended_jsonl_events": len(appended),
        "diagnosis": result["diagnosis"],
        "events": [event.model_dump(mode="json") for event in timeline],
    }
    rendered = json.dumps(output, ensure_ascii=False, indent=2)
    # A one-run demo snapshot for inspection, not an Event Store or Replay input.
    snapshot_file = ROOT / "data/incident-demo/INC-001-stage4-last-run.json"
    snapshot_file.parent.mkdir(parents=True, exist_ok=True)
    snapshot_file.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
