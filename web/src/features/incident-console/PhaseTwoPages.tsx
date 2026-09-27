import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  ChevronRight,
  CirclePause,
  Clock3,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  SkipForward,
  TriangleAlert,
} from 'lucide-react';
import { api } from '../../api/client';
import { useConsole } from './ConsoleLayout';
import { eventLabels, formatTime } from './model';

interface RecordedEvent {
  id: string;
  incidentId: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
interface RecordedRun {
  id: string;
  incidentId: string;
  source: string;
  events: RecordedEvent[];
}
interface Approval {
  id: string;
  incident: string;
  service: string;
  action: string;
  target: string;
  risk: 'ASK' | 'BLOCK';
  reason: string | null;
  requestedAt: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'BLOCKED';
  parameters?: Record<string, unknown>;
  runId?: string;
  evidence?: Array<{
    id: string;
    source: string;
    correlationId: string;
    preview: string;
  }>;
}
interface ApprovalData {
  pending: Approval[];
  history: Approval[];
}
interface EvaluationCase {
  id: string;
  service: string;
  scenario: string;
  expectedResult: string;
  actualResult: string;
  status: 'passed' | 'failed' | 'skipped' | 'not_run';
  kind: string;
}
interface EvaluationData {
  available: boolean;
  source: string | null;
  generatedAt: string | null;
  total: number;
  passed: number;
  categories: Array<{ name: string; total: number; passed: number }>;
  dataset: {
    total: number;
    diagnosable: number;
    conflict: number;
    insufficient: number;
  };
  cases: EvaluationCase[];
}
const actions: Record<string, string> = {
  restart_service: '重启服务',
  rollback_config: '回滚配置',
  modify_config: '修改配置',
  delete_database: '删除数据库',
};
const statuses: Record<string, string> = {
  PENDING: '待审批',
  APPROVED: '已批准',
  REJECTED: '已拒绝',
  EXPIRED: '已失效',
  BLOCKED: '已被安全策略阻止',
};
const categoryLabels: Record<string, string> = {
  Schema: 'Schema · 数据模型',
  Workflow: 'Workflow · 调查流程',
  Approval: 'Approval · 审批边界',
  Timeout: 'Timeout · 超时恢复',
  Replay: 'Replay · 只读回放',
};
function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="ic-page-heading">
      <div>
        <div className="ic-eyebrow">线上故障控制台</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}
function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`ic-notice ${error ? 'ic-error' : ''}`}
      role={error ? 'alert' : undefined}
    >
      {children}
    </div>
  );
}
function approvalTone(status: Approval['status']) {
  return status === 'APPROVED'
    ? 'green'
    : status === 'PENDING'
      ? 'amber'
      : status === 'BLOCKED'
        ? 'red'
        : status === 'REJECTED'
          ? 'orange'
          : 'neutral';
}
function ApprovalTable({
  rows,
  selected,
  onSelect,
  loading = false,
}: {
  rows: Approval[];
  selected: string | null;
  onSelect: (approval: Approval) => void;
  loading?: boolean;
}) {
  if (loading)
    return (
      <div className="ic-empty" role="status">
        正在读取审批记录…
      </div>
    );
  if (!rows.length)
    return (
      <div className="ic-empty">
        <ShieldCheck size={25} />
        <strong>暂无记录</strong>
        <span>此列表由真实 Gate 状态与 AgentEvent 生成。</span>
      </div>
    );
  return (
    <div className="ic-table-scroll">
      <table className="ic-table ic-approval-table">
        <thead>
          <tr>
            <th>故障</th>
            <th>服务</th>
            <th>操作</th>
            <th>目标</th>
            <th>风险</th>
            <th>原因</th>
            <th>申请时间</th>
            <th>状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={selected === row.id ? 'is-selected' : ''}
            >
              <td className="ic-mono">{row.incident}</td>
              <td>{row.service}</td>
              <td>{actions[row.action] ?? row.action}</td>
              <td className="ic-mono">{row.target}</td>
              <td>
                <span
                  className={`ic-badge ic-${row.risk === 'BLOCK' ? 'red' : 'amber'}`}
                >
                  {row.risk}
                </span>
              </td>
              <td className="ic-reason">
                {row.reason ?? '未记录；请核对诊断与证据'}
              </td>
              <td>
                {row.requestedAt ? formatTime(row.requestedAt) : '未记录'}
              </td>
              <td>
                <span className={`ic-badge ic-${approvalTone(row.status)}`}>
                  {statuses[row.status]}
                </span>
              </td>
              <td>
                <button
                  className="ic-icon-button"
                  aria-label={`查看 ${row.incident} 审批详情`}
                  onClick={() => onSelect(row)}
                >
                  <ChevronRight size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function ApprovalsPage() {
  const { snapshot } = useConsole();
  const [data, setData] = useState<ApprovalData | null>(null);
  const [runs, setRuns] = useState<RecordedRun[]>([]);
  const [selected, setSelected] = useState<Approval | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([
      api.get<ApprovalData>('/api/incident-console/approvals'),
      api.get<{ runs: RecordedRun[] }>('/api/incident-console/traces'),
    ])
      .then(([approvalData, traceData]) => {
        if (!active) return;
        setData(approvalData);
        setRuns(traceData.runs);
        setError('');
      })
      .catch((failure: { message?: string }) => {
        if (active) setError(failure.message ?? '审批数据读取失败');
      });
    return () => {
      active = false;
    };
  }, [revision]);
  useEffect(() => {
    const timer = setInterval(() => {
      api
        .get<ApprovalData>('/api/incident-console/approvals')
        .then(setData)
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, []);
  const current = selected
    ? data
      ? ([...data.pending, ...data.history].find(
          (item) => item.id === selected.id,
        ) ?? null)
      : selected
    : null;
  const run = current
    ? (runs.find((item) => item.id === current.runId) ??
      runs.find(
        (item) =>
          item.incidentId === current.incident &&
          item.events.some((event) => event.payload.approval_id === current.id),
      ))
    : null;
  const diagnosis = run?.events
    .filter((item) => item.type === 'DiagnosisCreated')
    .at(-1);
  const evidence =
    run?.events.filter((item) => item.type === 'EvidenceCollected') ?? [];
  const incident = snapshot?.incidents.find(
    (item) => item.id === current?.incident,
  );
  async function decide(decision: 'allow' | 'reject') {
    if (!current || current.status !== 'PENDING' || current.risk !== 'ASK')
      return;
    setBusy(true);
    setError('');
    try {
      await api.post(
        `/api/incident-console/approvals/${encodeURIComponent(current.id)}/decision`,
        { decision },
        12_000,
      );
      setSelected(null);
      setRevision((value) => value + 1);
    } catch (failure) {
      setError(
        (failure as { message?: string }).message ?? '审批失败，未执行操作',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="审批中心"
        subtitle="待审批项只来自当前运行中的 Approval Gate；历史记录不可再次批准"
      />
      <Notice>
        <ShieldAlert size={16} />
        BLOCK 操作已被安全策略阻止，不进入待审批队列，也不会出现批准按钮。
      </Notice>
      {error && (
        <Notice error>
          <TriangleAlert size={16} />
          {error}
          <button
            className="ic-button"
            onClick={() => setRevision((value) => value + 1)}
          >
            重试
          </button>
        </Notice>
      )}
      <div className="ic-two-section">
        <section className="ic-card">
          <div className="ic-panel-heading">
            <div>
              <h2>
                待审批{' '}
                <span className="ic-count">{data?.pending.length ?? '—'}</span>
              </h2>
              <p>仅展示 Gate 进程中仍有效的 ASK 请求</p>
            </div>
            <button
              className="ic-button"
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw size={14} />
              刷新
            </button>
          </div>
          <ApprovalTable
            rows={data?.pending ?? []}
            selected={current?.id ?? null}
            onSelect={setSelected}
            loading={!data && !error}
          />
        </section>
        <section className="ic-card">
          <div className="ic-panel-heading">
            <div>
              <h2>
                审批历史{' '}
                <span className="ic-count">{data?.history.length ?? '—'}</span>
              </h2>
              <p>来自历史 AgentEvent；失效请求不可恢复审批</p>
            </div>
            <span className="ic-badge ic-neutral">只读</span>
          </div>
          <ApprovalTable
            rows={data?.history ?? []}
            selected={current?.id ?? null}
            onSelect={setSelected}
            loading={!data && !error}
          />
        </section>
      </div>
      {current && (
        <section className="ic-card ic-approval-detail" aria-label="审批详情">
          <div className="ic-panel-heading">
            <div>
              <h2>审批详情 · {current.incident}</h2>
              <p>{current.id}</p>
            </div>
            <span className={`ic-badge ic-${approvalTone(current.status)}`}>
              {statuses[current.status]}
            </span>
          </div>
          <div className="ic-detail-grid">
            <div>
              <h3>故障摘要</h3>
              <dl>
                <dt>服务</dt>
                <dd>{current.service}</dd>
                <dt>告警</dt>
                <dd>{incident?.alert ?? '当前目录无故障摘要'}</dd>
                <dt>操作</dt>
                <dd>{actions[current.action] ?? current.action}</dd>
                <dt>目标</dt>
                <dd>{current.target}</dd>
              </dl>
            </div>
            <div>
              <h3>关联证据</h3>
              {current.evidence?.length ? (
                <ul>
                  {current.evidence.map((item) => (
                    <li key={item.id}>
                      <strong>{item.source}</strong> · {item.id}
                      <small>{item.correlationId}</small>
                      <pre>{item.preview}</pre>
                    </li>
                  ))}
                </ul>
              ) : evidence.length ? (
                <ul>
                  {evidence.map((item) => (
                    <li key={item.id}>
                      {String(
                        item.payload.source ?? item.payload.tool ?? '证据',
                      )}{' '}
                      · {String(item.payload.evidence_id ?? '—')}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>当前运行记录未包含证据摘要，请查看执行追踪。</p>
              )}
            </div>
            <div>
              <h3>根因分析</h3>
              <p>
                {typeof diagnosis?.payload.root_cause === 'string'
                  ? diagnosis.payload.root_cause
                  : '当前运行记录未包含根因分析。'}
              </p>
            </div>
            <div>
              <h3>操作参数</h3>
              <pre>
                {current.parameters
                  ? JSON.stringify(current.parameters, null, 2)
                  : '历史 AgentEvent 未记录完整参数'}
              </pre>
              <p>
                风险 · {current.risk}　原因 · {current.reason ?? '未记录'}
              </p>
            </div>
          </div>
          <div className="ic-approval-actions">
            {current.risk === 'BLOCK' ? (
              <strong className="ic-red">
                <ShieldAlert size={16} />
                已被安全策略阻止
              </strong>
            ) : current.status === 'PENDING' ? (
              <>
                <span>
                  批准后仍由后端 Gate 校验；当前 Executor 仅模拟处置。
                </span>
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
              </>
            ) : (
              <span>此记录不可再次审批。</span>
            )}
          </div>
        </section>
      )}
    </>
  );
}

export function TracesPage() {
  const [runs, setRuns] = useState<RecordedRun[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [replayActive, setReplayActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState(0);
  useEffect(() => {
    let active = true;
    api
      .get<{ runs: RecordedRun[] }>('/api/incident-console/traces')
      .then((value) => {
        if (!active) return;
        setRuns(value.runs);
        setSelectedId((previous) =>
          value.runs.some((run) => run.id === previous)
            ? previous
            : (value.runs[0]?.id ?? ''),
        );
        setLoading(false);
        setError('');
      })
      .catch((failure: { message?: string }) => {
        if (active) {
          setError(failure.message ?? '追踪数据读取失败');
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const run = runs.find((item) => item.id === selectedId);
  useEffect(() => {
    setPlaying(false);
    setReplayActive(false);
    setStep(0);
  }, [selectedId]);
  useEffect(() => {
    if (!playing || !run) return;
    const timer = setInterval(
      () =>
        setStep((value) => {
          if (value >= run.events.length) {
            setPlaying(false);
            return value;
          }
          return value + 1;
        }),
      750,
    );
    return () => clearInterval(timer);
  }, [playing, run]);
  const visibleEvents = useMemo(
    () =>
      replayActive ? (run?.events.slice(0, step) ?? []) : (run?.events ?? []),
    [replayActive, run, step],
  );
  return (
    <>
      <PageHeader
        title="执行追踪"
        subtitle="AgentEvent / JSONL 事件时间线与只读回放"
      />
      <Notice>
        <ShieldCheck size={16} />
        回放仅按历史事件推进视图；不会调用 LLM、Tool、Executor，也不会修改
        Incident。
      </Notice>
      {error && (
        <Notice error>
          <TriangleAlert size={16} />
          {error}
          <button
            className="ic-button"
            onClick={() => setRevision((value) => value + 1)}
          >
            重试
          </button>
        </Notice>
      )}
      <div className="ic-trace-layout">
        <aside className="ic-card ic-run-list">
          <div className="ic-panel-heading">
            <div>
              <h2>运行记录</h2>
              <p>{runs.length} 条 JSONL 会话</p>
            </div>
          </div>
          <div>
            {runs.map((item) => (
              <button
                key={item.id}
                className={`ic-run-item ${item.id === selectedId ? 'is-selected' : ''}`}
                onClick={() => setSelectedId(item.id)}
              >
                <strong>{item.incidentId}</strong>
                <span>
                  {item.source} · {item.events.length} 事件
                </span>
                <small>
                  {formatTime(item.events.at(-1)?.timestamp ?? null)}
                </small>
              </button>
            ))}
          </div>
        </aside>
        <section className="ic-card ic-trace-main">
          <div className="ic-panel-heading">
            <div>
              <h2>
                {run
                  ? `${run.incidentId} · AgentEvent 时间线`
                  : 'AgentEvent 时间线'}
              </h2>
              <p>按 JSONL 写入顺序展示 · 可展开事件详情</p>
            </div>
            <span className="ic-badge ic-neutral">只读</span>
          </div>
          {run && (
            <div className="ic-replay-bar">
              <div>
                <strong>Replay</strong>
                <span>
                  {replayActive
                    ? `${step} / ${run.events.length}`
                    : `${run.events.length} 个历史事件`}
                </span>
              </div>
              <button
                className="ic-button ic-primary"
                disabled={playing || run.events.length === 0}
                onClick={() => {
                  setReplayActive(true);
                  setPlaying(true);
                  if (!replayActive || step >= run.events.length) setStep(0);
                }}
              >
                <Play size={14} />
                {replayActive ? '继续回放' : '开始回放'}
              </button>
              <button
                className="ic-button"
                disabled={!replayActive || !playing}
                onClick={() => setPlaying(false)}
              >
                <CirclePause size={14} />
                暂停
              </button>
              <button
                className="ic-button"
                disabled={step >= run.events.length}
                onClick={() => {
                  setReplayActive(true);
                  setPlaying(false);
                  setStep((value) => Math.min(run.events.length, value + 1));
                }}
              >
                <SkipForward size={14} />
                下一步
              </button>
              <button
                className="ic-button"
                onClick={() => {
                  setReplayActive(true);
                  setPlaying(false);
                  setStep(0);
                }}
              >
                <RotateCcw size={14} />
                重新开始
              </button>
            </div>
          )}
          {loading ? (
            <div className="ic-empty" role="status">
              正在读取 JSONL…
            </div>
          ) : !run ? (
            <div className="ic-empty">
              <Clock3 size={26} />
              <strong>暂无可访问的追踪记录</strong>
              <span>运行故障调查后可读取 AgentEvent。</span>
            </div>
          ) : replayActive && step === 0 ? (
            <div className="ic-empty">
              <Play size={26} />
              <strong>等待回放</strong>
              <span>选择“开始回放”或“下一步”。</span>
            </div>
          ) : (
            <ol className="ic-trace-timeline">
              {visibleEvents.map((event, index) => (
                <li key={`${event.id}:${index}`}>
                  <span
                    className={`ic-trace-node ${event.type === 'ToolFailed' ? 'ic-red' : event.type === 'ApprovalRequested' ? 'ic-amber' : ''}`}
                  />
                  <div className="ic-trace-entry">
                    <div>
                      <strong>{eventLabels[event.type] ?? event.type}</strong>
                      <span className="ic-mono">{event.type}</span>
                      <time>{formatTime(event.timestamp)}</time>
                    </div>
                    <p>
                      {typeof event.payload.tool === 'string'
                        ? event.payload.tool
                        : typeof event.payload.action === 'string'
                          ? event.payload.action
                          : typeof event.payload.to === 'string'
                            ? event.payload.to
                            : event.incidentId}
                    </p>
                    <details>
                      <summary>查看事件详情</summary>
                      <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                    </details>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}

export function EvaluationsPage() {
  const [data, setData] = useState<EvaluationData | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    api
      .get<EvaluationData>('/api/incident-console/evaluation')
      .then((value) => {
        if (active) {
          setData(value);
          setError('');
        }
      })
      .catch((failure: { message?: string }) => {
        if (active) setError(failure.message ?? '评测产物读取失败');
      });
    return () => {
      active = false;
    };
  }, [revision]);
  return (
    <>
      <PageHeader
        title="评测中心"
        subtitle="核心测试与模拟故障案例的真实评测结果"
      />
      {error && (
        <Notice error>
          <TriangleAlert size={16} />
          {error}
          <button
            className="ic-button"
            onClick={() => setRevision((value) => value + 1)}
          >
            重试
          </button>
        </Notice>
      )}
      <Notice>
        <Activity size={16} />
        {data?.source ??
          (!data && !error ? '正在读取评测产物…' : '尚无可读取的 JUnit 结果')}
        {data?.generatedAt && ` · 更新于 ${formatTime(data.generatedAt)}`}
        ；案例均为模拟 Fixture，不代表生产故障。
      </Notice>
      <div className="ic-eval-summary">
        <article className="ic-card">
          <span>核心测试</span>
          <strong>
            {data?.available ? `${data.passed} / ${data.total}` : '— / —'}
          </strong>
          <small>
            {data?.available
              ? data.passed === data.total
                ? '全部通过'
                : '存在未通过项'
              : '尚无可核验结果；运行 pytest -m core --junitxml=data/evaluation/core-results.xml'}
          </small>
        </article>
        <article className="ic-card">
          <span>模拟故障案例</span>
          <strong>{data?.dataset.total ?? '—'} 例</strong>
          <small>从 evaluation/expected_cases.json 读取案例目录</small>
        </article>
        <article className="ic-card">
          <span>可诊断 / 证据冲突 / 证据不足</span>
          <strong>
            {data
              ? `${data.dataset.diagnosable} / ${data.dataset.conflict} / ${data.dataset.insufficient}`
              : '—'}
          </strong>
          <small>分类依据案例矩阵场景描述</small>
        </article>
      </div>
      <section className="ic-card">
        <div className="ic-panel-heading">
          <div>
            <h2>核心评测分类</h2>
            <p>从本次 JUnit testcases 逐条归类与计数</p>
          </div>
        </div>
        <div className="ic-eval-categories">
          {data?.categories.map((item) => (
            <div key={item.name}>
              <span>{categoryLabels[item.name] ?? item.name}</span>
              <strong>
                {data.available ? `${item.passed} / ${item.total}` : '— / —'}
              </strong>
              <div className="ic-eval-track">
                <i
                  style={{
                    width: item.total
                      ? `${(item.passed / item.total) * 100}%`
                      : '0%',
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="ic-card">
        <div className="ic-panel-heading">
          <div>
            <h2>故障案例</h2>
            <p>预期结果来自评测答案；实际结果来自调查流程测试断言</p>
          </div>
          <span className="ic-badge ic-neutral">模拟数据</span>
        </div>
        <div className="ic-table-scroll">
          <table className="ic-table ic-case-table">
            <thead>
              <tr>
                <th>案例</th>
                <th>服务</th>
                <th>场景</th>
                <th>预期结果</th>
                <th>实际结果</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {data?.cases.map((item) => (
                <tr key={item.id}>
                  <td className="ic-mono">{item.id}</td>
                  <td>{item.service}</td>
                  <td>{item.scenario}</td>
                  <td className="ic-mono">{item.expectedResult}</td>
                  <td>{item.actualResult}</td>
                  <td>
                    <span
                      className={`ic-badge ic-${item.status === 'passed' ? 'green' : item.status === 'failed' ? 'red' : 'neutral'}`}
                    >
                      {item.status === 'passed'
                        ? '通过'
                        : item.status === 'failed'
                          ? '失败'
                          : item.status === 'skipped'
                            ? '跳过'
                            : '未运行'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
