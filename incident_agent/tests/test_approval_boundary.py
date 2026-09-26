"""六个 pytest 用例经真实 MiniClaw ToolCall 检查审批门是否挡住 Executor。"""

import json
import subprocess
from pathlib import Path

import pytest


pytestmark = pytest.mark.core


ROOT = Path(__file__).resolve().parents[2]
HARNESS = Path(__file__).with_name("approval_boundary_harness.ts")


def run_tool_call(action: str, scenario: str) -> dict[str, object]:
    completed = subprocess.run(
        ["node", "--import", "tsx", str(HARNESS), action, scenario],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def assert_unapproved_does_not_execute(action: str) -> None:
    result = run_tool_call(action, "unapproved")
    assert result["action"] == action
    assert result["tool_status"] == "approval_required"
    assert result["approval_state"] == "AWAITING_APPROVAL"
    assert result["executor_called"] is False


def assert_rejected_does_not_execute(action: str) -> None:
    result = run_tool_call(action, "rejected")
    assert result["action"] == action
    assert result["tool_status"] == "approval_required"
    assert result["approval_state"] == "AWAITING_APPROVAL"
    assert result["reject_status"] == "rejected"
    assert result["post_reject_allow_status"] == "blocked"
    assert result["executor_called"] is False


def test_restart_service_unapproved_executor_not_called() -> None:
    assert_unapproved_does_not_execute("restart_service")


def test_restart_service_rejected_executor_not_called() -> None:
    assert_rejected_does_not_execute("restart_service")


def test_rollback_config_unapproved_executor_not_called() -> None:
    assert_unapproved_does_not_execute("rollback_config")


def test_rollback_config_rejected_executor_not_called() -> None:
    assert_rejected_does_not_execute("rollback_config")


def test_modify_config_unapproved_executor_not_called() -> None:
    assert_unapproved_does_not_execute("modify_config")


def test_modify_config_rejected_executor_not_called() -> None:
    assert_rejected_does_not_execute("modify_config")
