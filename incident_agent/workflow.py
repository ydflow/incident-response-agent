"""Evidence-first incident investigation with an injectable planning boundary.

The workflow owns state and event ordering. A gateway performs real read-only
ToolCalls, while a model or deterministic test double proposes the decision.
No remediation is executed by this investigation stage.
"""

from dataclasses import dataclass
from typing import Protocol

from .events import AgentEvent, EventType, InMemoryEventStore
from .models import Diagnosis, Evidence, Incident
from .state_machine import IncidentLifecycle, IncidentStatus


@dataclass(frozen=True)
class ToolBatch:
    evidence: tuple[Evidence, ...]
    events: tuple[dict[str, object], ...]


class EvidenceGateway(Protocol):
    def collect(self, incident_id: str) -> ToolBatch: ...


@dataclass(frozen=True)
class Escalation:
    reason: str


class DiagnosisPlanner(Protocol):
    def plan(
        self, incident: Incident, evidence: tuple[Evidence, ...]
    ) -> Diagnosis | Escalation: ...


@dataclass(frozen=True)
class WorkflowResult:
    status: IncidentStatus
    evidence: tuple[Evidence, ...]
    diagnosis: Diagnosis | None
    escalation_reason: str | None
    events: tuple[AgentEvent, ...]


class InvestigationWorkflow:
    def __init__(self, gateway: EvidenceGateway, planner: DiagnosisPlanner) -> None:
        self.gateway = gateway
        self.planner = planner

    def run(self, incident: Incident) -> WorkflowResult:
        events = InMemoryEventStore()
        lifecycle = IncidentLifecycle(incident, events)
        lifecycle.transition_to(IncidentStatus.INVESTIGATING)

        batch = self.gateway.collect(incident.incident_id)
        events.extend(list(batch.events), incident.incident_id)
        collected = tuple(batch.evidence)
        if any(item.incident_id != incident.incident_id for item in collected):
            raise ValueError("Evidence belongs to another incident")
        evidence_ids = [item.evidence_id for item in collected]
        event_ids = [
            event.payload.get("evidence_id")
            for event in events.snapshot()
            if event.event_type == EventType.EVIDENCE_COLLECTED
        ]
        if len(evidence_ids) != len(set(evidence_ids)) or evidence_ids != event_ids:
            raise ValueError("Evidence does not match completed ToolCall events")

        decision = self.planner.plan(incident, collected)
        if isinstance(decision, Escalation):
            if not decision.reason.strip():
                raise ValueError("Escalation requires a reason")
            lifecycle.transition_to(IncidentStatus.ESCALATED)
            return WorkflowResult(
                lifecycle.status,
                collected,
                None,
                decision.reason,
                events.snapshot(),
            )

        if not isinstance(decision, Diagnosis):
            raise TypeError("Planner must return Diagnosis or Escalation")
        if decision.incident_id != incident.incident_id:
            raise ValueError("Diagnosis belongs to another incident")
        if not set(decision.evidence_ids).issubset(evidence_ids):
            raise ValueError("Diagnosis cites Evidence not collected by the tools")
        events.emit(
            incident.incident_id,
            EventType.DIAGNOSIS_CREATED,
            {
                "evidence_ids": decision.evidence_ids,
                "confidence": decision.confidence,
                "root_cause": decision.root_cause,
            },
        )
        lifecycle.transition_to(IncidentStatus.DIAGNOSED)
        return WorkflowResult(
            lifecycle.status,
            collected,
            decision,
            None,
            events.snapshot(),
        )
