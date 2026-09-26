"""Incident 生命周期：只允许显式列出的状态转换。"""

from enum import Enum

from .events import EventType, InMemoryEventStore
from .models import Incident


class IncidentStatus(str, Enum):
    RECEIVED = "RECEIVED"
    INVESTIGATING = "INVESTIGATING"
    DIAGNOSED = "DIAGNOSED"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    RESOLVED = "RESOLVED"
    ESCALATED = "ESCALATED"
    FAILED = "FAILED"


# 终态没有后继状态。FAILED 只用于严重内部错误，不是普通的证据不足。
_ALLOWED_TRANSITIONS: dict[IncidentStatus, frozenset[IncidentStatus]] = {
    IncidentStatus.RECEIVED: frozenset({IncidentStatus.INVESTIGATING, IncidentStatus.FAILED}),
    IncidentStatus.INVESTIGATING: frozenset(
        {IncidentStatus.DIAGNOSED, IncidentStatus.ESCALATED, IncidentStatus.FAILED}
    ),
    IncidentStatus.DIAGNOSED: frozenset(
        {IncidentStatus.AWAITING_APPROVAL, IncidentStatus.ESCALATED, IncidentStatus.FAILED}
    ),
    IncidentStatus.AWAITING_APPROVAL: frozenset(
        {IncidentStatus.RESOLVED, IncidentStatus.ESCALATED, IncidentStatus.FAILED}
    ),
    IncidentStatus.RESOLVED: frozenset(),
    IncidentStatus.ESCALATED: frozenset(),
    IncidentStatus.FAILED: frozenset(),
}


def is_legal_transition(current: IncidentStatus, target: IncidentStatus) -> bool:
    """Read-only check shared by live transitions and historical replay."""
    return target in _ALLOWED_TRANSITIONS[current]


class InvalidTransitionError(ValueError):
    """调用方可通过错误类型或 code 识别非法转换。"""

    code = "invalid_incident_transition"

    def __init__(
        self, incident_id: str, current: IncidentStatus, target: IncidentStatus
    ) -> None:
        self.incident_id = incident_id
        self.current = current
        self.target = target
        super().__init__(f"{self.code}: {incident_id}: {current.value} -> {target.value}")


class IncidentLifecycle:
    """持有单个 Incident 的当前状态；不向 Agent 暴露任意状态写入接口。"""

    __slots__ = ("_incident_id", "_status", "_events")

    def __init__(
        self, incident: Incident, events: InMemoryEventStore | None = None
    ) -> None:
        if not isinstance(incident, Incident):
            raise TypeError("incident must be a validated Incident")
        self._incident_id = incident.incident_id
        self._status = IncidentStatus.RECEIVED
        self._events = events if events is not None else InMemoryEventStore()
        self._events.emit(
            self._incident_id,
            EventType.INCIDENT_CREATED,
            {"service": incident.service, "status": self._status.value},
        )

    @property
    def incident_id(self) -> str:
        return self._incident_id

    @property
    def status(self) -> IncidentStatus:
        return self._status

    @property
    def events(self) -> InMemoryEventStore:
        return self._events

    def transition_to(self, target: IncidentStatus) -> IncidentStatus:
        """先检查转换表；合法时才修改状态，失败时保持原状态。"""
        if not isinstance(target, IncidentStatus):
            raise TypeError("target must be an IncidentStatus")
        current = self._status
        if not is_legal_transition(current, target):
            raise InvalidTransitionError(self._incident_id, current, target)
        self._status = target
        self._events.emit(
            self._incident_id,
            EventType.STATUS_CHANGED,
            {"from": current.value, "to": target.value},
        )
        return self._status
