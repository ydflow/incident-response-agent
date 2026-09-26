"""Read-only reconstruction of incident history from AgentEvent JSONL.

Usage: py -m incident_agent.replay INC-001
This module imports no Agent runtime, Tool, LLM, or remediation executor.
"""

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping
from uuid import UUID

from pydantic import ValidationError

from .events import AgentEvent, EventType
from .state_machine import IncidentStatus, is_legal_transition


DEFAULT_RUNS_DIR = Path(__file__).resolve().parent.parent / "data/incident-runs"


class ReplayError(ValueError):
    """A damaged or inconsistent recorded history."""


class ReplayLoadError(ReplayError):
    """A JSONL line cannot be read as an AgentEvent."""


class ReplayOrderError(ReplayError):
    """An Event is impossible at this point in the recorded history."""


@dataclass(frozen=True)
class LoadedEvent:
    line_number: int
    event: AgentEvent


@dataclass
class ToolHistory:
    name: str
    result_status: str | None = None


@dataclass
class ReplayRun:
    number: int
    incident_id: str
    status: IncidentStatus
    timeline: list[str] = field(default_factory=list)
    tool_calls: dict[str, ToolHistory] = field(default_factory=dict)
    evidence_ids: list[str] = field(default_factory=list)
    diagnosis: dict[str, object] | None = None
    approvals: dict[str, str] = field(default_factory=dict)
    executed_actions: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def load_events(
    incident_id: str, runs_dir: Path = DEFAULT_RUNS_DIR
) -> tuple[LoadedEvent, ...]:
    """Parse each line independently; report the exact damaged line."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", incident_id):
        raise ReplayLoadError("incident_id contains unsupported filename characters")
    file_path = runs_dir / f"{incident_id}.jsonl"
    if not file_path.is_file():
        raise ReplayLoadError(f"Event file does not exist: {file_path}")
    loaded: list[LoadedEvent] = []
    try:
        with file_path.open("r", encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, 1):
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ReplayLoadError(
                        f"line {line_number}: invalid JSON ({error.msg})"
                    ) from error
                try:
                    event = AgentEvent.model_validate(value)
                except ValidationError as error:
                    field_name = ".".join(str(part) for part in error.errors()[0]["loc"])
                    raise ReplayLoadError(
                        f"line {line_number}: invalid AgentEvent field {field_name}"
                    ) from error
                if event.incident_id != incident_id:
                    raise ReplayLoadError(
                        f"line {line_number}: incident_id {event.incident_id} "
                        f"does not match {incident_id}"
                    )
                loaded.append(LoadedEvent(line_number, event))
    except UnicodeError as error:
        raise ReplayLoadError(f"Event file is not valid UTF-8: {file_path}") from error
    if not loaded:
        raise ReplayLoadError(f"Event file has no events: {file_path}")
    return tuple(loaded)


def _text(payload: Mapping[str, object], key: str, line: int) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise ReplayOrderError(f"line {line}: {key} must be a nonempty string")
    return value


def _status(value: str, line: int) -> IncidentStatus:
    try:
        return IncidentStatus(value)
    except ValueError as error:
        raise ReplayOrderError(f"line {line}: unknown incident status {value}") from error


def apply_event(run: ReplayRun, loaded: LoadedEvent) -> None:
    """Update only the reconstructed view; never invoke live business actions."""
    event = loaded.event
    kind = event.event_type
    payload = event.payload
    line = loaded.line_number
    detail = kind.value

    if kind == EventType.STATUS_CHANGED:
        before = _status(_text(payload, "from", line), line)
        after = _status(_text(payload, "to", line), line)
        if before != run.status or not is_legal_transition(before, after):
            raise ReplayOrderError(
                f"line {line}: invalid StatusChanged {before.value} -> {after.value}; "
                f"reconstructed status is {run.status.value}"
            )
        run.status = after
        detail = f"StatusChanged {before.value} -> {after.value}"
    elif kind == EventType.TOOL_CALLED:
        call_id = _text(payload, "tool_call_id", line)
        name = _text(payload, "tool", line)
        if call_id in run.tool_calls:
            raise ReplayOrderError(f"line {line}: duplicate ToolCall {call_id}")
        run.tool_calls[call_id] = ToolHistory(name)
        detail = f"ToolCalled {name} [{call_id}]"
    elif kind == EventType.TOOL_RESULT:
        call_id = _text(payload, "tool_call_id", line)
        name = _text(payload, "tool", line)
        status = _text(payload, "status", line)
        call = run.tool_calls.get(call_id)
        if call is None or call.name != name or call.result_status is not None:
            raise ReplayOrderError(
                f"line {line}: ToolResult has no matching unfinished ToolCalled"
            )
        call.result_status = status
        detail = f"ToolResult {name} ({status})"
    elif kind == EventType.EVIDENCE_COLLECTED:
        call_id = _text(payload, "tool_call_id", line)
        name = _text(payload, "tool", line)
        evidence_id = _text(payload, "evidence_id", line)
        call = run.tool_calls.get(call_id)
        if call is None or call.name != name or call.result_status != "returned":
            raise ReplayOrderError(
                f"line {line}: EvidenceCollected has no successful ToolResult"
            )
        run.evidence_ids.append(evidence_id)
        detail = f"EvidenceCollected {evidence_id}"
    elif kind == EventType.DIAGNOSIS_CREATED:
        evidence_ids = payload.get("evidence_ids")
        if (
            run.diagnosis is not None
            or not isinstance(evidence_ids, list)
            or not evidence_ids
            or not all(isinstance(item, str) for item in evidence_ids)
            or not set(evidence_ids).issubset(run.evidence_ids)
        ):
            raise ReplayOrderError(
                f"line {line}: DiagnosisCreated lacks previously collected Evidence"
            )
        run.diagnosis = dict(payload)
        detail = f"DiagnosisCreated ({len(evidence_ids)} Evidence IDs)"
    elif kind == EventType.APPROVAL_REQUESTED:
        approval_id = _text(payload, "approval_id", line)
        action = _text(payload, "action", line)
        if approval_id in run.approvals or not any(
            call.name == action for call in run.tool_calls.values()
        ):
            raise ReplayOrderError(
                f"line {line}: ApprovalRequested has no preceding action ToolCall"
            )
        run.approvals[approval_id] = "pending"
        if run.diagnosis is None:
            run.warnings.append(
                f"line {line}: ApprovalRequested before DiagnosisCreated"
            )
        detail = f"ApprovalRequested {action} [{approval_id}]"
    elif kind == EventType.APPROVAL_DECIDED:
        approval_id = _text(payload, "approval_id", line)
        decision = _text(payload, "decision", line)
        if run.approvals.get(approval_id) != "pending" or decision not in {
            "allow",
            "reject",
        }:
            raise ReplayOrderError(
                f"line {line}: ApprovalDecided has no pending request or valid decision"
            )
        run.approvals[approval_id] = decision
        if run.status != IncidentStatus.AWAITING_APPROVAL:
            run.warnings.append(
                f"line {line}: ApprovalDecided while status is {run.status.value}"
            )
        detail = f"ApprovalDecided {decision} [{approval_id}]"
    elif kind == EventType.ACTION_EXECUTED:
        approval_id = _text(payload, "approval_id", line)
        action = _text(payload, "action", line)
        if run.approvals.get(approval_id) != "allow":
            raise ReplayOrderError(
                f"line {line}: ActionExecuted has no preceding Allow decision"
            )
        run.executed_actions.append(action)
        detail = f"ActionExecuted {action}"
    elif kind == EventType.TOOL_FAILED:
        reason = _text(payload, "reason", line)
        call_id = payload.get("tool_call_id")
        approval_id = payload.get("approval_id")
        if isinstance(call_id, str):
            call = run.tool_calls.get(call_id)
            if call is None or call.result_status not in {"error", "timeout", "threw"}:
                raise ReplayOrderError(
                    f"line {line}: ToolFailed has no matching failed ToolResult"
                )
        elif not isinstance(approval_id, str) or run.approvals.get(approval_id) != "allow":
            raise ReplayOrderError(f"line {line}: ToolFailed has no failed call")
        run.failures.append(reason)
        detail = f"ToolFailed {reason}"
    else:
        raise ReplayOrderError(f"line {line}: unexpected {kind.value}")

    run.timeline.append(f"{len(run.timeline) + 1:02d} {detail}")


def reconstruct_runs(events: tuple[LoadedEvent, ...]) -> tuple[ReplayRun, ...]:
    """Walk the persisted order and split appended IncidentCreated runs."""
    runs: list[ReplayRun] = []
    current: ReplayRun | None = None
    seen_ids: set[UUID] = set()
    previous_time = None
    for loaded in events:
        event = loaded.event
        line = loaded.line_number
        if event.event_id in seen_ids:
            raise ReplayOrderError(f"line {line}: duplicate event_id {event.event_id}")
        seen_ids.add(event.event_id)
        if previous_time is not None and event.timestamp < previous_time:
            raise ReplayOrderError(f"line {line}: timestamp goes backwards")
        previous_time = event.timestamp
        if event.event_type == EventType.INCIDENT_CREATED:
            if current is not None:
                _finish(current)
                runs.append(current)
            initial = _status(_text(event.payload, "status", line), line)
            if initial != IncidentStatus.RECEIVED:
                raise ReplayOrderError(
                    f"line {line}: IncidentCreated must start at RECEIVED"
                )
            current = ReplayRun(len(runs) + 1, event.incident_id, initial)
            current.timeline.append("01 IncidentCreated status=RECEIVED")
            continue
        if current is None:
            raise ReplayOrderError(
                f"line {line}: {event.event_type.value} precedes IncidentCreated"
            )
        apply_event(current, loaded)
    assert current is not None
    _finish(current)
    runs.append(current)
    return tuple(runs)


def _finish(run: ReplayRun) -> None:
    unfinished = [
        call_id for call_id, call in run.tool_calls.items() if call.result_status is None
    ]
    if unfinished:
        run.warnings.append(f"ToolCall without ToolResult: {', '.join(unfinished)}")
    pending = [
        approval_id
        for approval_id, decision in run.approvals.items()
        if decision == "pending"
    ]
    if pending:
        run.warnings.append(f"Approval without decision: {', '.join(pending)}")


def render_replay(incident_id: str, runs: tuple[ReplayRun, ...]) -> str:
    lines = [f"Replay {incident_id}: {len(runs)} recorded run(s)"]
    for run in runs:
        lines.append(f"\nRun {run.number} ({len(run.timeline)} events)")
        lines.extend(run.timeline)
        lines.append(f"Final status: {run.status.value}")
        lines.append(f"Evidence IDs: {', '.join(run.evidence_ids) or '(none)'}")
        if run.diagnosis is not None:
            confidence = run.diagnosis.get("confidence")
            root_cause = run.diagnosis.get("root_cause")
            if confidence is not None:
                lines.append(f"Diagnosis confidence: {confidence}")
            if isinstance(root_cause, str):
                one_line_cause = root_cause.replace("\n", " ")
                lines.append(f"Diagnosis root cause: {one_line_cause}")
        lines.append(
            "Approval decisions: "
            + (", ".join(run.approvals.values()) or "(none)")
        )
        lines.append(f"Actions executed: {len(run.executed_actions)}")
        lines.append(
            f"Tool failures: {len(run.failures)}"
            + (f" ({', '.join(run.failures)})" if run.failures else "")
        )
        lines.extend(f"Warning: {warning}" for warning in run.warnings)
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only AgentEvent JSONL replay")
    parser.add_argument("incident_id", help="Incident ID, e.g. INC-001")
    args = parser.parse_args(argv)
    try:
        events = load_events(args.incident_id)
        runs = reconstruct_runs(events)
    except ReplayError as error:
        print(f"Replay error: {error}", file=sys.stderr)
        return 2
    print(render_replay(args.incident_id, runs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
