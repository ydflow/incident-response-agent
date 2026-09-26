"""状态机的合法路径、拒绝路径和状态写入边界。"""

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from incident_agent import Incident, IncidentLifecycle, IncidentStatus, InvalidTransitionError


def new_lifecycle() -> IncidentLifecycle:
    incident = Incident(
        incident_id="INC-001",
        service="payment-service",
        alert="HTTP 500 rate increased",
        started_at=datetime(2026, 9, 26, 8, 0, tzinfo=timezone.utc),
    )
    return IncidentLifecycle(incident)


def test_resolution_path_goes_through_approval_state() -> None:
    lifecycle = new_lifecycle()
    assert lifecycle.status is IncidentStatus.RECEIVED
    for target in (
        IncidentStatus.INVESTIGATING,
        IncidentStatus.DIAGNOSED,
        IncidentStatus.AWAITING_APPROVAL,
        IncidentStatus.RESOLVED,
    ):
        assert lifecycle.transition_to(target) is target
    assert lifecycle.status is IncidentStatus.RESOLVED


def test_insufficient_evidence_escalates_during_investigation() -> None:
    lifecycle = new_lifecycle()
    lifecycle.transition_to(IncidentStatus.INVESTIGATING)
    lifecycle.transition_to(IncidentStatus.ESCALATED)
    assert lifecycle.status is IncidentStatus.ESCALATED


@pytest.mark.parametrize(
    "path",
    [
        (IncidentStatus.INVESTIGATING, IncidentStatus.DIAGNOSED),
        (
            IncidentStatus.INVESTIGATING,
            IncidentStatus.DIAGNOSED,
            IncidentStatus.AWAITING_APPROVAL,
        ),
    ],
)
def test_unresolved_incident_can_escalate_from_later_active_states(
    path: tuple[IncidentStatus, ...],
) -> None:
    lifecycle = new_lifecycle()
    for target in path:
        lifecycle.transition_to(target)
    lifecycle.transition_to(IncidentStatus.ESCALATED)
    assert lifecycle.status is IncidentStatus.ESCALATED


@pytest.mark.parametrize(
    "path",
    [
        (),
        (IncidentStatus.INVESTIGATING,),
        (IncidentStatus.INVESTIGATING, IncidentStatus.DIAGNOSED),
        (
            IncidentStatus.INVESTIGATING,
            IncidentStatus.DIAGNOSED,
            IncidentStatus.AWAITING_APPROVAL,
        ),
    ],
)
def test_internal_error_can_fail_from_any_active_state(path: tuple[IncidentStatus, ...]) -> None:
    lifecycle = new_lifecycle()
    for target in path:
        lifecycle.transition_to(target)
    lifecycle.transition_to(IncidentStatus.FAILED)
    assert lifecycle.status is IncidentStatus.FAILED


def test_received_cannot_jump_to_resolved_and_error_identifies_transition() -> None:
    lifecycle = new_lifecycle()
    with pytest.raises(InvalidTransitionError) as error:
        lifecycle.transition_to(IncidentStatus.RESOLVED)
    assert error.value.code == "invalid_incident_transition"
    assert error.value.current is IncidentStatus.RECEIVED
    assert error.value.target is IncidentStatus.RESOLVED
    assert lifecycle.status is IncidentStatus.RECEIVED


def test_diagnosed_cannot_skip_approval_state_or_repeat_itself() -> None:
    lifecycle = new_lifecycle()
    lifecycle.transition_to(IncidentStatus.INVESTIGATING)
    lifecycle.transition_to(IncidentStatus.DIAGNOSED)
    for target in (IncidentStatus.RESOLVED, IncidentStatus.DIAGNOSED):
        with pytest.raises(InvalidTransitionError):
            lifecycle.transition_to(target)
        assert lifecycle.status is IncidentStatus.DIAGNOSED


@pytest.mark.parametrize(
    "terminal",
    [IncidentStatus.RESOLVED, IncidentStatus.ESCALATED, IncidentStatus.FAILED],
)
def test_terminal_states_cannot_transition_again(terminal: IncidentStatus) -> None:
    lifecycle = new_lifecycle()
    if terminal is IncidentStatus.RESOLVED:
        path = (
            IncidentStatus.INVESTIGATING,
            IncidentStatus.DIAGNOSED,
            IncidentStatus.AWAITING_APPROVAL,
            terminal,
        )
    elif terminal is IncidentStatus.ESCALATED:
        path = (IncidentStatus.INVESTIGATING, terminal)
    else:
        path = (terminal,)
    for target in path:
        lifecycle.transition_to(target)
    with pytest.raises(InvalidTransitionError):
        lifecycle.transition_to(IncidentStatus.INVESTIGATING)
    assert lifecycle.status is terminal


def test_status_is_not_a_public_input_or_assignable_property() -> None:
    lifecycle = new_lifecycle()
    with pytest.raises(AttributeError):
        lifecycle.status = IncidentStatus.RESOLVED  # type: ignore[misc]
    with pytest.raises(TypeError):
        lifecycle.transition_to("RESOLVED")  # type: ignore[arg-type]
    assert lifecycle.status is IncidentStatus.RECEIVED

    data = {
        "incident_id": "INC-001",
        "service": "payment-service",
        "alert": "HTTP 500 rate increased",
        "started_at": "2026-09-26T08:00:00Z",
        "status": "RESOLVED",
    }
    with pytest.raises(ValidationError):
        Incident.model_validate(data)
