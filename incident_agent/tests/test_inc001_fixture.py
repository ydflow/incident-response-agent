"""检查 INC-001 的五份静态证据能组成同一条时间线。"""

import json
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path

from incident_agent import Incident


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "INC-001"


def read_json(name: str) -> dict:
    return json.loads((FIXTURE / name).read_text(encoding="utf-8"))


def at(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def test_incident_is_valid_and_does_not_reveal_cause() -> None:
    data = read_json("incident.json")
    incident = Incident.model_validate(data)

    assert incident.incident_id == "INC-001"
    assert incident.service == "payment-service"
    assert set(data) == {"incident_id", "service", "alert", "started_at"}
    assert "pool" not in incident.alert.lower()
    assert "connection" not in incident.alert.lower()


def test_evidence_has_a_consistent_timeline() -> None:
    incident = read_json("incident.json")
    metrics = read_json("metrics.json")["samples"]
    logs = read_json("logs.json")["entries"]
    traces = read_json("trace.json")["traces"]
    patch = (FIXTURE / "git_diff.patch").read_text(encoding="utf-8")
    patch_date = next(line.removeprefix("Date: ") for line in patch.splitlines() if line.startswith("Date: "))
    failing_spans = traces[1]["spans"]

    assert (
        at(metrics[0]["observed_at"])
        < parsedate_to_datetime(patch_date)
        < at(metrics[1]["observed_at"])
        < at(logs[0]["timestamp"])
        <= at(incident["started_at"])
        < at(failing_spans[0]["started_at"])
        < at(logs[1]["timestamp"])
        < at(logs[2]["timestamp"])
        < at(metrics[2]["observed_at"])
    )
    assert at(failing_spans[1]["ended_at"]) == at(logs[1]["timestamp"])
    assert at(failing_spans[0]["ended_at"]) == at(logs[2]["timestamp"])
    for span in failing_spans:
        assert (at(span["ended_at"]) - at(span["started_at"])).total_seconds() * 1000 == span["duration_ms"]


def test_independent_sources_point_to_the_same_failure() -> None:
    metrics = read_json("metrics.json")
    logs = read_json("logs.json")
    traces = read_json("trace.json")
    patch = (FIXTURE / "git_diff.patch").read_text(encoding="utf-8")
    samples = metrics["samples"]
    healthy, failing = traces["traces"]

    assert metrics["service"] == logs["service"] == traces["service"] == "payment-service"
    assert "-    max_connections: 50" in patch
    assert "+    max_connections: 5" in patch
    assert samples[1]["db_request_p95_ms"] > samples[0]["db_request_p95_ms"]
    assert samples[2]["db_pool_waiting_requests"] > samples[0]["db_pool_waiting_requests"]
    assert samples[2]["http_5xx_rate_percent_1m"] > 5
    assert abs(samples[2]["db_query_p95_ms"] - samples[0]["db_query_p95_ms"]) < 10
    assert "database connection timeout" in logs["entries"][1]["message"]
    assert logs["entries"][1]["request_id"] == logs["entries"][2]["request_id"] == failing["request_id"]
    assert failing["spans"][1]["duration_ms"] > healthy["spans"][1]["duration_ms"]
    assert failing["spans"][0]["http_status"] == 500
