import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { formatTime, eventLabels, states } from './model';
import {
  taskStates,
  sourceLabels,
  reasonLabels,
  type LiveIncident,
  type LiveDetail,
  type LiveJob,
  type LiveEvent,
  type Observation,
  type Knowledge,
  type Paged,
  type Section,
} from './live-model';
import './live-console.css';
const base = '/api/incident-alerts/console/incidents';
const time = (v: string | number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(new Date(v).getTime())
    ? '—'
    : formatTime(new Date(v).toISOString());
const json = (v: unknown) => JSON.stringify(v, null, 2);
function useRead<T>(url: string | null, revision = 0) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    setLoading(!!url);
    if (url)
      void api
        .get<T>(url)
        .then((value) => {
          if (active) setData(value);
        })
        .catch((e: { status?: number; message?: string }) => {
          if (active)
            setError(
              e.status === 403
                ? '无权访问现场告警；需要告警权限及对应服务/环境范围。'
                : e.status === 404
                  ? '记录不存在或不在授权服务范围内。'
                  : (e.message ?? '读取失败，请稍后刷新。'),
            );
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    return () => {
      active = false;
    };
  }, [url, revision]);
  return { data, error, loading };
}
function Notice({ text }: { text: string }) {
  return (
    <div className="ic-notice" role="status">
      {text}
    </div>
  );
}
function Badge({ state }: { state: string }) {
  const item = taskStates[state] ?? states[state];
  return (
    <span className={`ic-badge ic-${item?.tone ?? 'neutral'}`}>
      {item?.label ?? state}
    </span>
  );
}
function Pager({
  data,
  onPage,
}: {
  data: Paged<unknown>;
  onPage: (offset: number) => void;
}) {
  return (
    <div className="ic-panel-footer">
      <span>
        第 {Math.floor(data.offset / data.limit) + 1} 页
        {data.total !== undefined ? ` · 共 ${data.total} 条` : ''}
      </span>
      <div className="ic-live-actions">
        <button
          className="ic-button"
          disabled={!data.offset}
          onClick={() => onPage(Math.max(0, data.offset - data.limit))}
        >
          上一页
        </button>
        <button
          className="ic-button"
          disabled={!data.has_more}
          onClick={() => onPage(data.offset + data.limit)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}
export function LiveConsolePage() {
  const [params, setParams] = useSearchParams(),
    [revision, setRevision] = useState(0),
    location = useLocation();
  const id = params.get('id'),
    run = params.get('run'),
    tab = params.get('tab') ?? 'report',
    offset = Math.max(0, Number(params.get('offset')) || 0),
    service = params.get('service') ?? '',
    environment = params.get('environment') ?? '';
  const update = (values: Record<string, string | null>) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(values))
        if (value) next.set(key, value);
        else next.delete(key);
      return next;
    });
  const query = new URLSearchParams({
    limit: '10',
    offset: String(offset),
    ...(service ? { service } : {}),
    ...(environment ? { environment } : {}),
  });
  const list = useRead<Paged<LiveIncident>>(
    !id ? `${base}?${query}` : null,
    revision,
  );
  const detail = useRead<LiveDetail>(
    id ? `${base}/${encodeURIComponent(id)}?limit=10&offset=${offset}` : null,
    revision,
  );
  const selectedRun = run ?? detail.data?.latest_run?.run_id ?? null;
  const go = (target: string, reference: string | null = null) =>
    update({ tab: target, offset: null, reference, run: selectedRun });
  const title =
    location.pathname === '/traces'
      ? '现场执行追踪'
      : location.pathname === '/incidents'
        ? '接入告警'
        : '调查任务';
  return (
    <>
      <div className="ic-page-heading">
        <div>
          <div className="ic-eyebrow">线上故障控制台</div>
          <h1>{title}</h1>
          <p>告警聚合、持久化调查与只读历史</p>
        </div>
        <button className="ic-button" onClick={() => setRevision((v) => v + 1)}>
          刷新现场数据
        </button>
      </div>
      <nav className="ic-live-actions" aria-label="数据来源">
        <Link className="ic-button" to="/incidents">
          模拟 Fixture
        </Link>
        <Link className="ic-button" to="/investigations">
          接入告警与调查
        </Link>
        <Link className="ic-button" to="/traces">
          历史 Fixture 追踪
        </Link>
      </nav>
      <Notice text="仅展示已保存的观测和调查结果。恢复告警不等于调查解决；本地受控服务不是生产数据库。" />
      {(list.error || detail.error) && (
        <div className="ic-notice ic-error" role="alert">
          {list.error || detail.error}
        </div>
      )}
      {(list.loading || detail.loading) && (
        <div className="ic-empty" role="status">
          正在读取现场记录…
        </div>
      )}
      {!id && list.data && (
        <section className="ic-card">
          <div className="ic-panel-heading">
            <div>
              <h2>接入告警列表</h2>
              <p>来源、服务、环境与任务分别记录</p>
            </div>
          </div>
          <form
            key={`${service}:${environment}`}
            className="ic-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              update({
                service: String(data.get('service') ?? ''),
                environment: String(data.get('environment') ?? ''),
                offset: null,
              });
            }}
          >
            <input
              className="ic-live-input"
              aria-label="现场服务过滤"
              name="service"
              placeholder="服务，例如 orders"
              defaultValue={service}
            />
            <input
              className="ic-live-input"
              aria-label="现场环境过滤"
              name="environment"
              placeholder="环境，例如 local"
              defaultValue={environment}
            />
            <button className="ic-button" type="submit">
              筛选现场告警
            </button>
            <button
              className="ic-button"
              type="button"
              onClick={() => {
                update({ service: null, environment: null, offset: null });
              }}
            >
              清除范围筛选
            </button>
          </form>
          {list.data.items.length ? (
            <div className="ic-table-scroll">
              <table className="ic-table ic-live-table">
                <thead>
                  <tr>
                    <th>告警 / 来源</th>
                    <th>服务 / 环境</th>
                    <th>级别</th>
                    <th>聚合 / 投递</th>
                    <th>最近接入</th>
                    <th>调查任务</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((item) => (
                    <tr key={item.incident_id}>
                      <td>
                        <Link
                          to={`/investigations?id=${item.incident_id}`}
                          aria-label={`查看 ${item.service} ${item.alert}`}
                        >
                          {item.alert}
                        </Link>
                        <small className="ic-live-muted">
                          {item.source} · {sourceLabels[item.source_mode]}
                        </small>
                        <small className="ic-live-id">{item.incident_id}</small>
                      </td>
                      <td>
                        {item.service}
                        <small className="ic-live-muted">
                          {item.environment}
                        </small>
                      </td>
                      <td>
                        {item.severity ?? '未知级别'}
                        {item.unknown_severity_count > 0 && (
                          <small className="ic-live-muted">
                            含未知外部级别
                          </small>
                        )}
                      </td>
                      <td>
                        {item.alert_count} 条告警 / {item.delivery_count} 次投递
                      </td>
                      <td>{time(item.last_received_at)}</td>
                      <td>
                        {item.job ? (
                          <Badge state={item.job.state} />
                        ) : (
                          <span>尚未建立任务</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="ic-empty">
              <strong>暂无接入告警</strong>
              <span>
                当前范围没有数据。可检查接入权限、来源与服务/环境；不会用模拟记录填充。
              </span>
            </div>
          )}
          <Pager
            data={list.data}
            onPage={(n) => update({ offset: String(n) })}
          />
        </section>
      )}
      {id && detail.data && (
        <>
          <Link className="ic-button" to="/investigations">
            返回现场列表
          </Link>
          <section className="ic-card">
            <div className="ic-panel-heading">
              <div>
                <h2>{detail.data.incident.alert}</h2>
                <p className="ic-live-id">{id}</p>
              </div>
              <span className="ic-badge ic-neutral">
                {sourceLabels[detail.data.source_mode]}
              </span>
            </div>
            <dl className="ic-live-meta">
              {Object.entries({
                来源: detail.data.metadata.source,
                服务: detail.data.metadata.service,
                环境: detail.data.metadata.environment,
                优先级: detail.data.metadata.severity ?? '未知级别',
                告警状态:
                  detail.data.metadata.alert_status === 'resolved'
                    ? '告警已恢复（调查未自动解决）'
                    : '告警触发',
                '聚合 / 投递': `${detail.data.metadata.alert_count} 条 / ${detail.data.metadata.delivery_count} 次`,
                首次发生: time(detail.data.metadata.started_at),
                最近发生: time(detail.data.metadata.last_started_at),
                首次接入: time(detail.data.metadata.first_received_at),
                最近接入: time(detail.data.metadata.last_received_at),
                聚合窗口结束: time(detail.data.metadata.window_end),
              }).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <details className="ic-live-block">
              <summary>告警投递与聚合明细</summary>
              <p>聚合键：{detail.data.metadata.aggregation_key}</p>
              {detail.data.alerts.items.map((alert) => (
                <article key={alert.occurrence_id}>
                  <strong>{alert.source_summary.summary}</strong>
                  <p>
                    外部 ID：{alert.external_id || '未提供'} · 指纹：
                    {alert.fingerprint} · {alert.status}
                  </p>
                  <p>
                    外部级别：{alert.severity_raw || '未提供'} →{' '}
                    {alert.severity ?? '未知级别，需人工核对'} ·{' '}
                    {time(alert.starts_at)}
                  </p>
                </article>
              ))}
              <Pager
                data={detail.data.alerts}
                onPage={(n) => update({ offset: String(n) })}
              />
            </details>
          </section>
          <section className="ic-card">
            <div className="ic-panel-heading">
              <h2>持久化调查任务</h2>
            </div>
            {detail.data.jobs.length ? (
              detail.data.jobs.map((job) => (
                <Task
                  key={job.job_id}
                  job={job}
                  selectedRun={selectedRun}
                  onSelect={(r) =>
                    update({
                      run: r,
                      tab: 'report',
                      offset: null,
                      reference: null,
                    })
                  }
                />
              ))
            ) : (
              <div className="ic-empty">尚无调查任务；没有运行或模型结果。</div>
            )}
          </section>
          {selectedRun ? (
            <>
              <nav className="ic-live-actions" aria-label="调查详情分区">
                {[
                  ['report', '调查结论'],
                  ['evidence', '观测 Evidence'],
                  ['knowledge', 'Runbook 引用'],
                  ['events', '执行追踪'],
                  ['attempts', '模型工具尝试'],
                  ['replay', '只读回放'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={`ic-button ${tab === value ? 'ic-primary' : ''}`}
                    aria-pressed={tab === value}
                    onClick={() => go(value)}
                  >
                    {label}
                  </button>
                ))}
                <Link
                  className="ic-button"
                  to={`/traces?mode=live&id=${id}&run=${selectedRun}&tab=events`}
                >
                  在执行追踪页打开
                </Link>
              </nav>
              <RunSection
                id={id}
                run={selectedRun}
                tab={tab}
                offset={tab === 'report' ? 0 : offset}
                reference={params.get('reference')}
                revision={revision}
                onPage={(n) => update({ offset: String(n) })}
                onReference={(type, ref) => go(type, ref)}
              />
            </>
          ) : (
            <div className="ic-card ic-empty">
              任务尚未领取，没有运行、取证或结论。
            </div>
          )}
        </>
      )}
    </>
  );
}
function Task({
  job,
  selectedRun,
  onSelect,
}: {
  job: LiveJob;
  selectedRun: string | null;
  onSelect: (run: string) => void;
}) {
  return (
    <article className="ic-live-block">
      <div className="ic-live-actions">
        <Badge state={job.state} />
        <strong>
          第 {job.generation} 轮 · 尝试 {job.attempt} / 2
        </strong>
      </div>
      <p>
        输入版本 {job.input_revision} · 待合并告警版本 {job.pending_revision} ·
        租约截至 {time(job.lease_expires_at)}
        {job.state === 'retry_wait' ? ` · 下次执行 ${time(job.next_at)}` : ''}
      </p>
      {job.error_code && (
        <p className="ic-live-failure">
          原因：{reasonLabels[job.error_code] ?? job.error_code}（
          {job.error_code}）
        </p>
      )}
      {['failed', 'manual', 'blocked'].includes(job.state) && (
        <p>
          后续处理：核对数据源与缺失证据，联系有权限的宿主管理员。重查需明确建立新一轮任务；不会自动批准或执行动作。
        </p>
      )}
      <div className="ic-live-actions">
        {job.runs?.map((run) => (
          <button
            key={run.run_id}
            className={`ic-button ${selectedRun === run.run_id ? 'ic-primary' : ''}`}
            onClick={() => onSelect(run.run_id)}
          >
            尝试 {run.attempt} · {states[run.status]?.label ?? run.status}
          </button>
        ))}
      </div>
    </article>
  );
}
function RunSection({
  id,
  run,
  tab,
  offset,
  reference,
  revision,
  onPage,
  onReference,
}: {
  id: string;
  run: string;
  tab: string;
  offset: number;
  reference: string | null;
  revision: number;
  onPage: (n: number) => void;
  onReference: (type: string, id: string) => void;
}) {
  const known = [
    'report',
    'evidence',
    'knowledge',
    'events',
    'attempts',
    'replay',
  ].includes(tab)
    ? tab
    : 'report';
  const q = new URLSearchParams({
    section: known,
    limit: known === 'evidence' ? '2' : '10',
    offset: String(offset),
    ...(reference && ['evidence', 'knowledge'].includes(known)
      ? { reference }
      : {}),
  });
  const { data, error, loading } = useRead<Section<unknown>>(
    known === 'replay' ? null : `${base}/${id}/runs/${run}?${q}`,
    revision,
  );
  if (known === 'replay') return <Replay id={id} run={run} />;
  if (error)
    return (
      <div className="ic-notice ic-error" role="alert">
        {error}
      </div>
    );
  if (loading || !data)
    return (
      <div className="ic-empty" role="status">
        正在读取调查历史…
      </div>
    );
  return (
    <section className="ic-card">
      <div className="ic-panel-heading">
        <div>
          <h2>
            {known === 'report'
              ? '调查结论与影响范围'
              : known === 'evidence'
                ? '观测 Evidence'
                : known === 'knowledge'
                  ? 'Runbook 引用'
                  : known === 'attempts'
                    ? '实际模型工具尝试'
                    : '真实事件时间线'}
          </h2>
          <p className="ic-live-id">{run}</p>
        </div>
        <Badge state={data.run.status} />
      </div>
      <p className="ic-live-block">
        {data.run.mode === 'protocol_stub'
          ? '协议桩验证 · 非真实模型推理'
          : data.run.mode === 'host_no_model'
            ? '未使用模型 · 宿主记录观测与升级'
            : '受限 Pi 模型会话'}{' '}
        · 工具预留 {data.run.tool_calls} · 模型 HTTP 预留{' '}
        {data.run.model_requests}
      </p>
      {known === 'report' ? (
        <Report data={data} onReference={onReference} />
      ) : known === 'evidence' ? (
        (data.items as Observation[]).map((e) => (
          <article className="ic-live-block" key={e.evidence_id}>
            <h3>
              {e.source} · {e.observation.source_id}
            </h3>
            <code className="ic-live-id">{e.evidence_id}</code>
            <button
              className="ic-button"
              onClick={() => onReference('evidence', e.evidence_id)}
            >
              定位此证据
            </button>
            <p>
              观测：{time(e.timestamp)} · {e.observation.service} /{' '}
              {e.observation.environment} · 关联 ID {e.correlation_id}
            </p>
            <p>
              查询范围：{time(e.observation.window.from)}—
              {time(e.observation.window.to)} ·{' '}
              {e.observation.status === 'empty' ? '成功但为空' : '成功返回'} ·{' '}
              {e.observation.items.length} 条
            </p>
            {(e.observation.truncated ||
              e.observation.retention_dropped > 0) && (
              <p>返回/保留数据有截断，不能推断完整故障范围。</p>
            )}
            <details open={!!reference}>
              <summary>原始观测片段与引用位置（items 从 0 开始）</summary>
              <pre>{json(e.observation.items)}</pre>
            </details>
          </article>
        ))
      ) : known === 'knowledge' ? (
        (data.items as Knowledge[]).map((k) => (
          <article className="ic-live-block" key={k.reference_id}>
            <h3>
              {k.doc_id} · {k.section}
            </h3>
            <code className="ic-live-id">引用 {k.reference_id}</code>
            <button
              className="ic-button"
              onClick={() => onReference('knowledge', k.reference_id)}
            >
              定位此手册引用
            </button>
            <p>
              版本 {k.version} · 行 {k.start_line}–{k.end_line} · 位置{' '}
              {k.start_offset}–{k.end_offset}
            </p>
            <p className="ic-live-id">内容哈希 {k.version_hash}</p>
            <p>
              检索 {time(k.retrieved_at)} · 排名 {k.rank} · 查询 {k.query}
            </p>
            <pre>{k.snippet}</pre>
            <p>手册只支持调查步骤，不是当前故障成立的观测证据。</p>
          </article>
        ))
      ) : known === 'events' ? (
        <Timeline events={data.items as LiveEvent[]} />
      ) : (
        <pre className="ic-live-block">{json(data.items)}</pre>
      )}
      {known !== 'report' && !data.items.length && (
        <div className="ic-empty">
          暂无
          {known === 'knowledge'
            ? '手册命中'
            : known === 'evidence'
              ? '观测证据'
              : '历史记录'}
          ；没有重新取证或补造数据。
        </div>
      )}
      {known !== 'report' && <Pager data={data} onPage={onPage} />}
    </section>
  );
}
function Report({
  data,
  onReference,
}: {
  data: Section<unknown>;
  onReference: (type: string, id: string) => void;
}) {
  const r = data.report;
  return (
    <>
      <Notice text={data.scope.impact} />
      {!r ? (
        <div className="ic-empty">尚无调查报告；状态不等于已有根因结论。</div>
      ) : (
        <div className="ic-live-report">
          {r.recovery_verification && (
            <article className="ic-live-recovery">
              <h3>只读恢复验证记录</h3>
              <p>
                人工恢复声明：
                {r.recovery_verification.manual_action.reported_result} ·{' '}
                {time(r.recovery_verification.manual_action.performed_at)} ·
                目标资源槽{' '}
                {r.recovery_verification.manual_action.restored_capacity}
              </p>
              <p>
                恢复观测结果：
                {
                  {
                    verified: '通过',
                    not_recovered: '未达标',
                    inconclusive: '证据不足',
                  }[r.recovery_verification.result]
                }
              </p>
              <p>
                故障最终调查状态：
                {r.recovery_verification.incident_final_status} ·
                待人工复核，不自动宣告已解决。
              </p>
              <p>
                恢复前基线运行：
                <code className="ic-live-id">
                  {r.recovery_verification.baseline_run_id}
                </code>
              </p>
              {r.recovery_verification.checks.map((check) => (
                <p key={check.name}>
                  {check.status} · {check.detail}
                </p>
              ))}
              {r.recovery_verification.observation_refs.map((ref) => (
                <button
                  className="ic-button"
                  key={ref}
                  onClick={() => onReference('evidence', ref)}
                >
                  查看恢复观测证据
                </button>
              ))}
            </article>
          )}
          <article>
            <h3>已核验的观测字段</h3>
            {r.facts.length ? (
              r.facts.map((f, i) => (
                <p key={i}>
                  {f.field} = {String(f.value)}{' '}
                  <button
                    className="ic-button"
                    onClick={() => onReference('evidence', f.evidence_id)}
                  >
                    查看证据 · items[{f.item_index}]
                  </button>
                  <code className="ic-live-id">{f.evidence_id}</code>
                </p>
              ))
            ) : (
              <p>暂无可引用的观测字段。</p>
            )}
          </article>
          <article>
            <h3>诊断与根因假设</h3>
            {r.diagnosis ? (
              <>
                <p>{r.diagnosis.root_cause}</p>
                <p>
                  模型自报 confidence：{r.diagnosis.confidence}
                  ；不作为执行授权。
                </p>
                <p>{r.diagnosis.recommendation}</p>
              </>
            ) : (
              <p>尚无已保存诊断；不能从手册或状态推定根因。</p>
            )}
            {r.hypotheses.map((h, i) => (
              <div key={i}>
                <p>假设：{h.hypothesis}</p>
                {h.evidence_ids.map((ref) => (
                  <button
                    className="ic-button"
                    key={ref}
                    onClick={() => onReference('evidence', ref)}
                  >
                    观测引用
                  </button>
                ))}
                {h.knowledge_reference_ids.map((ref) => (
                  <button
                    className="ic-button"
                    key={ref}
                    onClick={() => onReference('knowledge', ref)}
                  >
                    手册引用
                  </button>
                ))}
              </div>
            ))}
          </article>
          <article>
            <h3>手册建议</h3>
            {r.handbook_suggestions.length ? (
              r.handbook_suggestions.map((h, i) => (
                <p key={i}>
                  {h.suggestion}{' '}
                  {h.knowledge_reference_ids.map((ref) => (
                    <button
                      className="ic-button"
                      key={ref}
                      onClick={() => onReference('knowledge', ref)}
                    >
                      查看手册引用
                    </button>
                  ))}
                </p>
              ))
            ) : (
              <p>没有保存手册建议；可单独查看本次检索命中。</p>
            )}
          </article>
          <article>
            <h3>不足、冲突与补充调查</h3>
            {r.escalation_reason && (
              <p>
                升级原因：
                {reasonLabels[r.escalation_reason] ?? r.escalation_reason}
              </p>
            )}
            {r.limitations.map((v, i) => (
              <p key={`l${i}`}>{v}</p>
            ))}
            {r.conflicts.map((v, i) => (
              <div key={`c${i}`}>
                <p>冲突：{v.description}</p>
                {v.evidence_ids.map((ref) => (
                  <button
                    className="ic-button"
                    key={ref}
                    onClick={() => onReference('evidence', ref)}
                  >
                    核对冲突证据
                  </button>
                ))}
              </div>
            ))}
            {r.next_evidence_requests.map((v, i) => (
              <p key={`n${i}`}>补证据：{v}</p>
            ))}
          </article>
          <Notice text="引用存在、范围和字段值检查不构成通用语义证明。当前调查只读，没有动作执行权限；原模拟审批仍由可信宿主 Gate 校验。" />
        </div>
      )}
    </>
  );
}
function Timeline({ events }: { events: LiveEvent[] }) {
  return (
    <ol className="ic-trace-timeline ic-live-timeline">
      {events.map((e, i) => (
        <li key={e.event_id}>
          <span className="ic-trace-node" />
          <div>
            <strong>{eventLabels[e.event_type] ?? e.event_type}</strong>
            <p>
              {time(e.timestamp)} · {e.event_type}
            </p>
            <details>
              <summary>事件 {i + 1} · 查看真实记录</summary>
              <pre>{json(e.payload)}</pre>
              {e.payload_truncated && (
                <p>
                  大工具响应仅显示事件元数据；请在观测证据或 Runbook
                  分区查看已保存内容。
                </p>
              )}
            </details>
          </div>
        </li>
      ))}
    </ol>
  );
}
function Replay({ id, run }: { id: string; run: string }) {
  const [events, setEvents] = useState<LiveEvent[] | null>(null),
    [error, setError] = useState(''),
    [step, setStep] = useState(0),
    [playing, setPlaying] = useState(false);
  useEffect(() => {
    let active = true;
    setEvents(null);
    setStep(0);
    setPlaying(false);
    setError('');
    void (async () => {
      const history: LiveEvent[] = [];
      for (let offset = 0; offset < 140; offset += 20) {
        const data = await api.get<Section<LiveEvent>>(
          `${base}/${id}/runs/${run}?section=replay&limit=20&offset=${offset}`,
        );
        history.push(...data.items);
        if (!data.has_more) {
          if (active) setEvents(history);
          return;
        }
      }
      throw Error('历史事件超过回放上限，未播放截断记录。');
    })().catch((e) => {
      if (active) setError(e.message ?? '历史读取失败');
    });
    return () => {
      active = false;
    };
  }, [id, run]);
  useEffect(() => {
    if (!playing || !events) return;
    const timer = setInterval(
      () => setStep((v) => Math.min(events.length, v + 1)),
      600,
    );
    return () => clearInterval(timer);
  }, [playing, events]);
  useEffect(() => {
    if (events && step >= events.length) setPlaying(false);
  }, [step, events]);
  const visible = events?.slice(0, step) ?? [],
    state = visible.filter((e) => e.event_type === 'StatusChanged').at(-1)
      ?.payload.to;
  return (
    <section className="ic-card">
      <div className="ic-panel-heading">
        <h2>只读回放</h2>
        <span className="ic-badge ic-neutral">已保存历史 · 不重新调用工具</span>
      </div>
      <Notice text="只推进历史视图，不调用模型、Provider、Runbook、Executor 或审批接口。" />
      {error && (
        <div className="ic-notice ic-error" role="alert">
          {error}
        </div>
      )}
      {events === null && !error ? (
        <div className="ic-empty">正在读取历史…</div>
      ) : events?.length ? (
        <>
          <div className="ic-live-block ic-live-actions">
            <strong>
              {step} / {events.length} 个历史事件 ·{' '}
              {typeof state === 'string'
                ? (states[state]?.label ?? state)
                : '尚未播放状态事件'}
            </strong>
            <button
              className="ic-button ic-primary"
              disabled={playing || step >= events.length}
              onClick={() => setPlaying(true)}
            >
              开始回放
            </button>
            <button
              className="ic-button"
              disabled={!playing}
              onClick={() => setPlaying(false)}
            >
              暂停回放
            </button>
            <button
              className="ic-button"
              disabled={step >= events.length}
              onClick={() => {
                setPlaying(false);
                setStep((v) => Math.min(events.length, v + 1));
              }}
            >
              下一事件
            </button>
            <button
              className="ic-button"
              onClick={() => {
                setPlaying(false);
                setStep(0);
              }}
            >
              回放归零
            </button>
          </div>
          <Timeline events={visible} />
        </>
      ) : (
        !error && (
          <div className="ic-empty">
            本次运行没有历史事件；不会生成虚假轨迹。
          </div>
        )
      )}
    </section>
  );
}
