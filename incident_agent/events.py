"""Shared incident event contract with memory and append-only JSONL stores.

The TypeScript runner emits the same JSON shape. Importing runner events through
``extend`` validates them before they join the Python lifecycle timeline; the
runner has already written those events to JSONL at emission time.
"""

from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from uuid import UUID, uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, JsonValue


class EventType(str, Enum):
    INCIDENT_CREATED = "IncidentCreated"
    STATUS_CHANGED = "StatusChanged"
    TOOL_CALLED = "ToolCalled"
    TOOL_RESULT = "ToolResult"
    EVIDENCE_COLLECTED = "EvidenceCollected"
    DIAGNOSIS_CREATED = "DiagnosisCreated"
    APPROVAL_REQUESTED = "ApprovalRequested"
    APPROVAL_DECIDED = "ApprovalDecided"
    ACTION_EXECUTED = "ActionExecuted"
    TOOL_FAILED = "ToolFailed"


class AgentEvent(BaseModel):
    """One immutable, JSON-serializable observation of a completed code path."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    event_id: UUID
    incident_id: str = Field(min_length=1)
    event_type: EventType
    timestamp: AwareDatetime
    payload: dict[str, JsonValue]


class InMemoryEventStore:
    def __init__(self) -> None:
        self._events: list[AgentEvent] = []

    def emit(
        self, incident_id: str, event_type: EventType, payload: dict[str, JsonValue]
    ) -> AgentEvent:
        event = AgentEvent(
            event_id=uuid4(),
            incident_id=incident_id,
            event_type=event_type,
            timestamp=datetime.now(timezone.utc),
            payload=payload,
        )
        self._persist(event)
        self._events.append(event)
        return event

    def _persist(self, event: AgentEvent) -> None:
        """Memory-only store has no disk side effect."""

    def extend(self, events: list[dict[str, object]], incident_id: str) -> None:
        """Import events already persisted by their producer; never duplicate lines."""
        validated = [AgentEvent.model_validate(event) for event in events]
        if any(event.incident_id != incident_id for event in validated):
            raise ValueError("event incident_id does not match the active incident")
        self._events.extend(validated)

    def snapshot(self) -> tuple[AgentEvent, ...]:
        return tuple(self._events)


class JsonlEventStore(InMemoryEventStore):
    """Synchronously append one JSON object per emitted event; never truncate."""

    def __init__(self, file_path: Path) -> None:
        super().__init__()
        self.file_path = Path(file_path)

    def _persist(self, event: AgentEvent) -> None:
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        with self.file_path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(event.model_dump_json() + "\n")
