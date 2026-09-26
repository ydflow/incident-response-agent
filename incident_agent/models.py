"""第一阶段的故障、证据和诊断数据模型。"""

from typing import Annotated

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, field_validator


# 先去掉首尾空格，再拒绝空字符串；三个模型共享同一条规则。
NonBlankText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class Incident(BaseModel):
    """记录发生了什么故障，以及它从何时开始。"""

    model_config = ConfigDict(extra="forbid")

    incident_id: NonBlankText
    service: NonBlankText
    alert: NonBlankText
    started_at: AwareDatetime  # 必须有时区，避免跨系统比较时间时产生歧义。


class Evidence(BaseModel):
    """记录某次故障调查得到的一条可关联证据。"""

    model_config = ConfigDict(extra="forbid")

    evidence_id: NonBlankText
    incident_id: NonBlankText
    source: NonBlankText
    timestamp: AwareDatetime
    content: NonBlankText
    correlation_id: NonBlankText


class Diagnosis(BaseModel):
    """记录基于证据形成的诊断和建议。"""

    model_config = ConfigDict(extra="forbid")

    incident_id: NonBlankText
    root_cause: NonBlankText
    confidence: float = Field(ge=0.0, le=1.0, allow_inf_nan=False, strict=True)
    evidence_ids: list[NonBlankText] = Field(min_length=1)
    recommendation: NonBlankText

    @field_validator("evidence_ids")
    @classmethod
    def evidence_ids_must_be_unique(cls, ids: list[str]) -> list[str]:
        # 同一条证据不能在一次诊断中被重复引用。
        if len(ids) != len(set(ids)):
            raise ValueError("evidence_ids must not contain duplicates")
        return ids
