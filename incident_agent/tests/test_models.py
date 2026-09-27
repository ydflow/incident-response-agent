"""每个领域模型各有 3 个合法和 3 个非法输入，共 18 个用例。"""

from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from incident_agent import Diagnosis, Evidence, Incident

pytestmark = pytest.mark.core


UTC_TIME = datetime(2026, 9, 26, 8, 0, tzinfo=timezone.utc)
CHINA_TIME = datetime(2026, 9, 26, 16, 0, tzinfo=timezone(timedelta(hours=8)))


@pytest.mark.parametrize(
    ("changes", "expected_id"),
    [
        pytest.param({}, "inc-001", id="standard-incident"),
        pytest.param({"started_at": CHINA_TIME, "service": "payments"}, "inc-001", id="timezone-offset"),
        pytest.param({"incident_id": " inc-001 ", "started_at": "2026-09-26T08:00:00Z"}, "inc-001", id="iso-time-and-trimmed-id"),
    ],
)
def test_incident_valid(changes: dict[str, object], expected_id: str) -> None:
    data = {"incident_id": "inc-001", "service": "api", "alert": "high error rate", "started_at": UTC_TIME}
    incident = Incident.model_validate({**data, **changes})
    assert incident.incident_id == expected_id
    assert incident.started_at.utcoffset() is not None


@pytest.mark.parametrize(
    ("changes", "missing", "invalid_field"),
    [
        pytest.param({"incident_id": "  "}, None, "incident_id", id="blank-id"),
        pytest.param({"started_at": datetime(2026, 9, 26, 8, 0)}, None, "started_at", id="naive-time"),
        pytest.param({}, "alert", "alert", id="missing-alert"),
    ],
)
def test_incident_invalid(changes: dict[str, object], missing: str | None, invalid_field: str) -> None:
    data = {"incident_id": "inc-001", "service": "api", "alert": "high error rate", "started_at": UTC_TIME}
    data.update(changes)
    if missing:
        data.pop(missing)
    with pytest.raises(ValidationError) as error:
        Incident.model_validate(data)
    assert any(item["loc"] == (invalid_field,) for item in error.value.errors())


@pytest.mark.parametrize(
    ("changes", "expected_source"),
    [
        pytest.param({}, "logs", id="log-evidence"),
        pytest.param({"timestamp": CHINA_TIME, "source": "metrics"}, "metrics", id="metrics-with-offset"),
        pytest.param({"timestamp": "2026-09-26T08:00:00Z", "source": " trace "}, "trace", id="iso-time-and-trimmed-source"),
    ],
)
def test_evidence_valid(changes: dict[str, object], expected_source: str) -> None:
    data = {"evidence_id": "ev-001", "incident_id": "inc-001", "source": "logs", "timestamp": UTC_TIME, "content": "HTTP 500 spike", "correlation_id": "req-123"}
    evidence = Evidence.model_validate({**data, **changes})
    assert evidence.source == expected_source
    assert evidence.timestamp.utcoffset() is not None


@pytest.mark.parametrize(
    ("changes", "invalid_field"),
    [
        pytest.param({"content": "  "}, "content", id="blank-content"),
        pytest.param({"timestamp": datetime(2026, 9, 26, 8, 0)}, "timestamp", id="naive-time"),
        pytest.param({"correlation_id": ""}, "correlation_id", id="blank-correlation-id"),
    ],
)
def test_evidence_invalid(changes: dict[str, object], invalid_field: str) -> None:
    data = {"evidence_id": "ev-001", "incident_id": "inc-001", "source": "logs", "timestamp": UTC_TIME, "content": "HTTP 500 spike", "correlation_id": "req-123"}
    with pytest.raises(ValidationError) as error:
        Evidence.model_validate({**data, **changes})
    assert any(item["loc"] == (invalid_field,) for item in error.value.errors())


@pytest.mark.parametrize(
    ("changes", "expected_evidence_ids"),
    [
        pytest.param({}, ["ev-001"], id="single-evidence"),
        pytest.param({"confidence": 0.0, "evidence_ids": ["ev-001", "ev-002"]}, ["ev-001", "ev-002"], id="zero-confidence-and-two-evidence"),
        pytest.param({"confidence": 1.0, "evidence_ids": [" ev-003 "]}, ["ev-003"], id="full-confidence-and-trimmed-reference"),
    ],
)
def test_diagnosis_valid(changes: dict[str, object], expected_evidence_ids: list[str]) -> None:
    data = {"incident_id": "inc-001", "root_cause": "database connection pool exhausted", "confidence": 0.7, "evidence_ids": ["ev-001"], "recommendation": "inspect pool saturation"}
    diagnosis = Diagnosis.model_validate({**data, **changes})
    assert diagnosis.evidence_ids == expected_evidence_ids
    assert 0.0 <= diagnosis.confidence <= 1.0


@pytest.mark.parametrize(
    ("changes", "invalid_field"),
    [
        pytest.param({"confidence": -0.1}, "confidence", id="confidence-below-zero"),
        pytest.param({"confidence": 1.1}, "confidence", id="confidence-above-one"),
        pytest.param({"evidence_ids": ["ev-001", " ev-001 "]}, "evidence_ids", id="duplicate-evidence-reference"),
    ],
)
def test_diagnosis_invalid(changes: dict[str, object], invalid_field: str) -> None:
    data = {"incident_id": "inc-001", "root_cause": "database connection pool exhausted", "confidence": 0.7, "evidence_ids": ["ev-001"], "recommendation": "inspect pool saturation"}
    with pytest.raises(ValidationError) as error:
        Diagnosis.model_validate({**data, **changes})
    assert any(item["loc"] == (invalid_field,) for item in error.value.errors())
