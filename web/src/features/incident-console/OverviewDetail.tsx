import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  Code2,
  Database,
  FileText,
  GitBranch,
  ScanSearch,
  ShieldAlert,
} from 'lucide-react';
import { api } from '../../api/client';
import { eventLabels, formatTime, states, type Incident } from './model';
import { StateBadge } from './IncidentTable';

interface RecordedEvent {
  id: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
interface RecordedRun {
  id: string;
  incidentId: string;
  events: RecordedEvent[];
}
interface Approval {
  id: string;
  incident: string;
  action: string;
  target: string;
  risk: 'ASK' | 'BLOCK';
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'BLOCKED';
  reason: string | null;
}
interface Evaluation {
  available: boolean;
  generatedAt: string | null;
  passed: number;
  total: number;
  categories: Array<{ name: string; passed: number; total: number }>;
}
const sourceTabs = [
  { key: 'logs', label: '日志', icon: FileText },
  { key: 'metrics', label: '指标', icon: Database },
  { key: 'trace', label: '链路', icon: GitBranch },
  { key: 'git_diff', label: '代码变更', icon: Code2 },
] as const;
type SourceKey = (typeof sourceTabs)[number]['key'];
const sourceLabels: Record<string, string> = {
  logs: '日志',
  metrics: '指标',
  trace: '链路',
  git_diff: '代码变更',
};
const actionLabels: Record<string, string> = {
  restart_service: '重启服务',
  rollback_config: '回滚配置',
  modify_config: '修改配置',
  delete_database: '删除数据库',
};
const text = (value: unknown) => (typeof value === 'string' ? value : null);

function eventSummary(event: RecordedEvent) {
  const payload = event.payload;
  const tool = text(payload.tool);
  if (event.type === 'ToolCalled' && tool) return `调用 ${tool}`;
  if (event.type === 'ToolResult' && tool)
    return `${tool} · ${text(payload.status) ?? '已返回'}`;
  if (event.type === 'EvidenceCollected')
    return `${sourceLabels[text(payload.source) ?? ''] ?? text(payload.source) ?? '证据'} · ${text(payload.evidence_id) ?? '已记录'}`;
  if (event.type === 'StatusChanged')
    return (
      states[text(payload.to) ?? '']?.label ?? text(payload.to) ?? '状态已更新'
    );
  if (event.type === 'ApprovalRequested')
    return `${actionLabels[text(payload.action) ?? ''] ?? text(payload.action) ?? '处置操作'} · 等待审批`;
  if (event.type === 'DiagnosisCreated') return '已生成根因分析';
  return tool ?? text(payload.action) ?? '事件已记录';
}

export function OverviewDetail({
  incident,
  canReadHistory,
  refreshKey,
}: {
  incident: Incident | null;
  canReadHistory: boolean | null;
  refreshKey: string | null;
}) {
  const [runs, setRuns] = useState<RecordedRun[] | null>(null);
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [loadError, setLoadError] = useState('');
  const [source, setSource] = useState<SourceKey>('logs');
  const [activeSection, setActiveSection] = useState('timeline');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [decisionError, setDecisionError] = useState('');

  useEffect(() => {
    if (canReadHistory !== true) return;
    let active = true;
    Promise.allSettled([
      api.get<{ runs: RecordedRun[] }>('/api/incident-console/traces'),
      api.get<{ pending: Approval[]; history: Approval[] }>(
        '/api/incident-console/approvals',
      ),
      api.get<Evaluation>('/api/incident-console/evaluation'),
    ]).then(([traceResult, approvalResult, evaluationResult]) => {
      if (!active) return;
      if (traceResult.status === 'fulfilled') setRuns(traceResult.value.runs);
      if (approvalResult.status === 'fulfilled')
        setApprovals([
          ...approvalResult.value.pending,
          ...approvalResult.value.history,
        ]);
      if (evaluationResult.status === 'fulfilled')
        setEvaluation(evaluationResult.value);
      setLoadError(
        traceResult.status === 'rejected' ||
          approvalResult.status === 'rejected' ||
          evaluationResult.status === 'rejected'
          ? '部分详情暂不可用，可在对应页面重试。'
          : '',
      );
    });
    return () => {
      active = false;
    };
  }, [canReadHistory, refreshKey, revision]);

  const run = useMemo(
    () => runs?.find((item) => item.incidentId === incident?.id) ?? null,
    [runs, incident?.id],
  );
  const diagnosis = run?.events
    .filter((event) => event.type === 'DiagnosisCreated')
    .at(-1);
  const rootCause = text(diagnosis?.payload.root_cause);
  const confidence =
    typeof diagnosis?.payload.confidence === 'number'
      ? diagnosis.payload.confidence
      : null;
  const evidenceIds = Array.isArray(diagnosis?.payload.evidence_ids)
    ? diagnosis.payload.evidence_ids.filter(
        (id): id is string => typeof id === 'string',
      )
    : [];
  const evidence =
    run?.events.filter((event) => event.type === 'EvidenceCollected') ?? [];
  const currentEvidence = evidence.filter(
    (event) =>
      event.payload.source === source ||
      event.payload.tool === `query_${source}`,
  );
  const incidentApprovals =
    approvals?.filter((item) => item.incident === incident?.id) ?? [];
  const liveApproval = incidentApprovals.find(
    (item) => item.status === 'PENDING' && item.risk === 'ASK',
  );
  const latestApproval = liveApproval ?? incidentApprovals[0];

  async function decide(decision: 'allow' | 'reject') {
    if (!liveApproval || busy) return;
    setBusy(true);
    setDecisionError('');
    try {
      await api.post(
        `/api/incident-console/approvals/${encodeURIComponent(liveApproval.id)}/decision`,
        { decision },
        12_000,
      );
      setRevision((value) => value + 1);
    } catch (failure) {
      setDecisionError(
        (failure as { message?: string }).message ??
          '审批失败，请刷新审批记录核对。',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="ic-card ic-overview-detail" aria-label="故障详情预览">
        <div className="ic-detail-heading">
          <div className="ic-detail-heading-main">
            <strong>{incident?.id ?? '故障详情'}</strong>
            {incident && <StateBadge status={incident.status} />}
            {incident && (
              <span className="ic-detail-service">{incident.service}</span>
            )}
            <span className="ic-detail-alert">
              {incident?.alert ?? '选择故障后查看调查详情'}
            </span>
          </div>
          <div className="ic-detail-meta">
            <span>
              <Clock3 size={13} />
              开始时间 {formatTime(incident?.startedAt ?? null)}
            </span>
            <span>严重程度 {incident?.severity ?? '未分级'}</span>
            <span>数据来源 Fixture · 本地运行记录</span>
          </div>
          <nav className="ic-detail-tabs" aria-label="详情区域">
            {[
              ['timeline', '调查过程'],
              ['evidence', '证据数据'],
              ['diagnosis', '根因分析'],
              ['action', '处置建议'],
            ].map(([key, label]) => (
              <button
                key={key}
                className={activeSection === key ? 'is-active' : ''}
                onClick={() => {
                  setActiveSection(key);
                  document
                    .getElementById(`ic-detail-${key}`)
                    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
        {loadError && (
          <div className="ic-detail-notice" role="status">
            {loadError}
          </div>
        )}
        <div className="ic-detail-panels">
          <section
            id="ic-detail-timeline"
            className="ic-detail-panel ic-detail-timeline"
          >
            <h3>
              调查过程{' '}
              <span>{run ? `${run.events.length} 条事件` : 'AgentEvent'}</span>
            </h3>
            {canReadHistory === false ? (
              <p className="ic-detail-empty">当前账户无运行记录查看权限。</p>
            ) : !run ? (
              <p className="ic-detail-empty">
                {runs ? '当前故障暂无可访问的运行记录。' : '正在读取运行记录…'}
              </p>
            ) : (
              <ol>
                {run.events.slice(-8).map((event) => (
                  <li key={event.id} className={`ic-timeline-${event.type}`}>
                    <time>{formatTime(event.timestamp).slice(-8)}</time>
                    <div>
                      <strong>{eventLabels[event.type] ?? event.type}</strong>
                      <p>{eventSummary(event)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <Link to="/traces">
              查看完整执行追踪 <ArrowRight size={13} />
            </Link>
          </section>
          <section
            id="ic-detail-evidence"
            className="ic-detail-panel ic-detail-evidence"
          >
            <h3>
              证据数据{' '}
              <span>
                {evidence.length ? `${evidence.length} 条记录` : '只读'}
              </span>
            </h3>
            <div
              className="ic-evidence-tabs"
              role="tablist"
              aria-label="证据类型"
            >
              {sourceTabs.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={source === key}
                  className={source === key ? 'is-active' : ''}
                  onClick={() => setSource(key)}
                >
                  <Icon size={13} />
                  {label}
                </button>
              ))}
            </div>
            <div className="ic-evidence-content" role="tabpanel">
              {currentEvidence.length ? (
                currentEvidence.map((event) => (
                  <div className="ic-evidence-item" key={event.id}>
                    <span>
                      {text(event.payload.evidence_id) ?? '已采集证据'}
                    </span>
                    <small>{formatTime(event.timestamp)}</small>
                    <code>
                      {text(event.payload.tool) ?? sourceLabels[source]}
                    </code>
                  </div>
                ))
              ) : (
                <p className="ic-detail-empty">
                  {canReadHistory === false
                    ? '当前账户无证据查看权限。'
                    : !runs
                      ? '正在读取证据记录…'
                      : '当前运行未记录此类证据。'}
                </p>
              )}
              <p className="ic-evidence-caption">
                当前接口仅提供证据元数据，原始内容请在执行追踪中核对。
              </p>
            </div>
          </section>
          <section
            id="ic-detail-diagnosis"
            className="ic-detail-panel ic-detail-diagnosis"
          >
            <h3>
              <ScanSearch size={15} />
              根因分析{' '}
              {confidence !== null && (
                <span className="ic-badge ic-green">
                  置信度 {Math.round(confidence * 100)}%
                </span>
              )}
            </h3>
            {rootCause ? (
              <>
                <span className="ic-detail-field">根因</span>
                <strong className="ic-root-cause">{rootCause}</strong>
                <span className="ic-detail-field">关联证据</span>
                <div className="ic-evidence-ids">
                  {evidenceIds.map((id) => (
                    <code key={id}>{id}</code>
                  ))}
                </div>
                <p>以上内容来自当前运行的 DiagnosisCreated 事件。</p>
              </>
            ) : (
              <p className="ic-detail-empty">
                {canReadHistory === false
                  ? '当前账户无诊断查看权限。'
                  : !runs
                    ? '正在读取诊断结果…'
                    : '当前运行尚无根因分析结果。'}
              </p>
            )}
          </section>
          <section
            id="ic-detail-action"
            className="ic-detail-panel ic-detail-action"
          >
            <h3>
              <ShieldAlert size={15} />
              处置建议{' '}
              {latestApproval && (
                <span
                  className={`ic-badge ic-${latestApproval.status === 'PENDING' ? 'amber' : 'neutral'}`}
                >
                  {latestApproval.status === 'PENDING'
                    ? '需要人工审批'
                    : '历史记录'}
                </span>
              )}
            </h3>
            {latestApproval ? (
              <>
                <span className="ic-detail-field">建议操作</span>
                <strong className="ic-action-name">
                  {actionLabels[latestApproval.action] ?? latestApproval.action}
                </strong>
                <code>
                  {latestApproval.action}({latestApproval.target})
                </code>
                <span className="ic-detail-field">
                  风险等级 · {latestApproval.risk}
                </span>
                <p>
                  {latestApproval.reason ??
                    '当前审批记录未提供原因说明，请核对证据与诊断。'}
                </p>
                {liveApproval ? (
                  <div className="ic-detail-actions">
                    <button
                      className="ic-button"
                      disabled={busy}
                      onClick={() => void decide('reject')}
                    >
                      拒绝
                    </button>
                    <button
                      className="ic-button ic-primary"
                      disabled={busy}
                      onClick={() => void decide('allow')}
                    >
                      批准
                    </button>
                  </div>
                ) : (
                  <Link to="/approvals">
                    查看审批记录 <ArrowRight size={13} />
                  </Link>
                )}
                {decisionError && (
                  <p className="ic-red" role="alert">
                    {decisionError}
                  </p>
                )}
              </>
            ) : (
              <p className="ic-detail-empty">
                {canReadHistory === false
                  ? '当前账户无审批记录查看权限。'
                  : !approvals
                    ? '正在读取审批记录…'
                    : '当前故障暂无待审批处置；历史运行记录也未提供建议。'}
              </p>
            )}
          </section>
        </div>
      </section>
      <EvaluationStrip data={evaluation} canReadHistory={canReadHistory} />
    </>
  );
}

function EvaluationStrip({
  data,
  canReadHistory,
}: {
  data: Evaluation | null;
  canReadHistory: boolean | null;
}) {
  return (
    <section className="ic-card ic-evaluation-strip" aria-label="评测摘要">
      <div>
        <CheckCircle2
          size={17}
          className={
            data?.available && data.passed === data.total
              ? 'ic-green'
              : 'ic-muted'
          }
        />
        <strong>评测中心</strong>
        <span>
          {data?.generatedAt
            ? `更新于 ${formatTime(data.generatedAt)}`
            : '最近一次评测结果'}
        </span>
      </div>
      <strong className="ic-eval-total">
        {data?.available
          ? `${data.passed} / ${data.total} 核心测试通过`
          : canReadHistory === null
            ? '正在读取评测结果…'
            : '暂无可核验的评测结果'}
      </strong>
      {data?.available && (
        <div className="ic-eval-pills">
          {data.categories
            .filter((item) => item.total > 0)
            .map((item) => (
              <span key={item.name}>
                {item.name}{' '}
                <b
                  className={
                    item.passed === item.total ? 'ic-green' : 'ic-amber'
                  }
                >
                  {item.passed}/{item.total}
                </b>
              </span>
            ))}
        </div>
      )}
      <Link to="/evaluations">
        {canReadHistory === false ? '了解权限' : '查看详情'}{' '}
        <ArrowRight size={13} />
      </Link>
    </section>
  );
}
