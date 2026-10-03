import { useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  Clock3,
  Construction,
  Database,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { consoleNavigation, useConsole } from './ConsoleLayout';
import { IncidentTable } from './IncidentTable';
import { OverviewDetail } from './OverviewDetail';
import { eventLabels, formatTime, inRange, states } from './model';
import './overview.css';

function DataNotice() {
  const { snapshot, error, refresh } = useConsole();
  return (
    <>
      {error && (
        <div className="ic-notice ic-error" role="alert">
          <TriangleAlert size={16} />
          <span>
            {error}
            {snapshot ? ' 当前显示上次成功获取的记录。' : ''}
          </span>
          <button className="ic-button" onClick={refresh}>
            重试
          </button>
        </div>
      )}
      {snapshot && !snapshot.historyAccess && (
        <div className="ic-notice">
          当前账户仅可查看 Fixture
          目录。运行记录暂无租户归属信息，仅管理员可见。
        </div>
      )}
      {snapshot?.warnings.map((warning) => (
        <div className="ic-notice ic-warning" key={warning}>
          {warning}
        </div>
      ))}
    </>
  );
}
function PageHeading({ title, subtitle }: { title: string; subtitle: string }) {
  const { snapshot, refresh, loading } = useConsole();
  return (
    <div className="ic-page-heading">
      <div>
        <div className="ic-eyebrow">线上故障控制台</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="ic-refresh">
        <span>
          {snapshot
            ? `更新于 ${formatTime(snapshot.updatedAt)}`
            : loading
              ? '正在获取数据…'
              : '数据未加载'}
        </span>
        <button className="ic-button" onClick={refresh} aria-label="刷新数据">
          <RefreshCw size={14} />
          刷新
        </button>
      </div>
    </div>
  );
}
export function OverviewPage() {
  const { snapshot, loading, range } = useConsole();
  const [selectedId, setSelectedId] = useState('');
  const now = Date.now();
  const incidents =
    snapshot?.incidents.filter((incident) =>
      inRange(incident.startedAt, range, now),
    ) ?? [];
  const events =
    snapshot?.events
      .filter((event) => inRange(event.timestamp, range, now))
      .slice(0, 12) ?? [];
  const selectedIncident =
    incidents.find((incident) => incident.id === selectedId) ??
    incidents[0] ??
    null;
  const hasRecordedDuration = incidents
    .slice(0, 5)
    .some(
      (incident) =>
        incident.lastEventAt &&
        Date.parse(incident.lastEventAt) >= Date.parse(incident.startedAt),
    );
  const kpis = [
    {
      label: '总故障数',
      icon: TriangleAlert,
      count: incidents.length,
      tone: 'red',
      note: '当前时间范围内的案例',
    },
    {
      label: '调查中',
      icon: Search,
      count: incidents.filter((i) => i.status === 'INVESTIGATING').length,
      tone: 'blue',
      note: '最新运行的记录状态',
    },
    {
      label: '待审批',
      icon: ShieldCheck,
      count: incidents.filter((i) => i.status === 'AWAITING_APPROVAL').length,
      tone: 'amber',
      note: '历史状态，非在线审批队列',
    },
    {
      label: '已解决',
      icon: CheckCircle2,
      count: incidents.filter((i) => i.status === 'RESOLVED').length,
      tone: 'green',
      note: '最新运行的记录状态',
    },
    {
      label: '已升级',
      icon: ArrowUpRight,
      count: incidents.filter((i) => i.status === 'ESCALATED').length,
      tone: 'orange',
      note: '最新运行的记录状态',
    },
  ];
  return (
    <div className="ic-overview-page">
      <PageHeading title="运行总览" subtitle="故障态势、Agent 调查与人工审批" />
      <DataNotice />
      <div className="ic-source-line">
        <span>
          <Database size={14} />
          Fixture 案例 · 本地运行记录
        </span>
        <span>故障按开始时间筛选 · 事件按发生时间筛选</span>
      </div>
      <section className="ic-kpis" aria-label="故障统计">
        {kpis.map(({ label, icon: Icon, count, tone, note }, index) => (
          <article className={`ic-card ic-kpi ic-kpi-${tone}`} key={label}>
            <div className="ic-kpi-top">
              <span className="ic-kpi-icon">
                <Icon size={20} />
              </span>
              <span>{label}</span>
            </div>
            <strong className="ic-kpi-value">
              {!snapshot || (index > 0 && !snapshot.historyAccess)
                ? '—'
                : count}
            </strong>
            <small>{note}</small>
          </article>
        ))}
      </section>
      <div className="ic-overview-grid">
        <section className="ic-card ic-recent">
          <div className="ic-panel-heading">
            <div>
              <h2>最近故障</h2>
              <p>最新案例及其最近一次运行状态</p>
            </div>
            <Link to="/incidents">
              查看全部 <ArrowRight size={14} />
            </Link>
          </div>
          <IncidentTable
            incidents={incidents.slice(0, 5)}
            loading={loading}
            unavailable={!snapshot}
            selectedId={selectedIncident?.id}
            onSelect={(incident) => setSelectedId(incident.id)}
            showDuration={hasRecordedDuration}
          />
          <div className="ic-panel-footer">
            <CircleDot size={13} />
            案例为模拟场景；“已诊断”不等于“已解决”。
          </div>
        </section>
        <section className="ic-card ic-events">
          <div className="ic-panel-heading">
            <div>
              <h2>
                <Activity size={16} />
                Agent 实时动态
              </h2>
              <p>AgentEvent · 每 15 秒刷新记录</p>
            </div>
            <Link to="/traces">
              查看完整日志 <ArrowRight size={14} />
            </Link>
          </div>
          {loading ? (
            <div className="ic-empty" role="status">
              正在读取事件…
            </div>
          ) : events.length ? (
            <ol className="ic-event-list">
              {events.map((event) => (
                <li key={event.id}>
                  <span
                    className={`ic-event-node ${event.type === 'ToolFailed' ? 'ic-red' : ''}`}
                  />
                  <div>
                    <div className="ic-event-title">
                      <time title={event.timestamp}>
                        {formatTime(event.timestamp).slice(-8)}
                      </time>
                      <strong>{eventLabels[event.type] ?? event.type}</strong>
                    </div>
                    <p>
                      {event.tool
                        ? `${event.type === 'ToolCalled' ? '调用 ' : ''}${event.tool}`
                        : (event.status ? states[event.status]?.label : null) ||
                          event.type}
                    </p>
                    <Link
                      to={`/incidents?q=${encodeURIComponent(event.incidentId)}`}
                    >
                      {event.incidentId}
                    </Link>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="ic-empty">
              <Clock3 size={28} />
              <strong>
                {snapshot ? '暂无可显示的事件' : '事件数据暂不可用'}
              </strong>
              <span>
                {snapshot
                  ? '当前范围内无可访问的运行记录。'
                  : '请恢复数据连接后重试。'}
              </span>
            </div>
          )}
          <div className="ic-panel-footer">
            显示历史记录，不代表 Runtime 在线。
          </div>
        </section>
      </div>
      <OverviewDetail
        incident={selectedIncident}
        canReadHistory={snapshot?.historyAccess ?? null}
        refreshKey={snapshot?.updatedAt ?? null}
      />
    </div>
  );
}
export function IncidentsPage() {
  const { snapshot, loading, range } = useConsole();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const severity = params.get('severity') ?? '';
  const update = (key: string, value: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  const incidents = useMemo(
    () =>
      (snapshot?.incidents ?? []).filter(
        (incident) =>
          (!query ||
            `${incident.id} ${incident.service} ${incident.alert}`
              .toLowerCase()
              .includes(query.toLowerCase().trim())) &&
          (!status || incident.status === status) &&
          (!severity ||
            (severity === 'ungraded'
              ? !incident.severity
              : incident.severity === severity)) &&
          inRange(incident.startedAt, range, Date.now()),
      ),
    [snapshot, query, status, severity, range],
  );
  return (
    <>
      <PageHeading
        title="故障中心"
        subtitle="集中查看故障、调查状态与服务告警"
      />
      <Link className="ic-button" to="/investigations">
        查看接入告警与现场调查
      </Link>
      <DataNotice />
      <section className="ic-card">
        <div className="ic-panel-heading">
          <div>
            <h2>
              故障列表{' '}
              <span className="ic-count">
                {snapshot ? incidents.length : '—'}
              </span>
            </h2>
            <p>Fixture 案例 · 状态来自最近一次本地运行</p>
          </div>
        </div>
        <div className="ic-filters">
          <label className="ic-list-search">
            <Search size={16} />
            <input
              aria-label="搜索故障"
              placeholder="搜索 ID、服务或告警内容"
              value={query}
              onChange={(event) => update('q', event.target.value)}
            />
          </label>
          <select
            aria-label="状态过滤"
            value={status}
            onChange={(event) => update('status', event.target.value)}
          >
            <option value="">全部状态</option>
            {Object.entries(states).map(([key, state]) => (
              <option key={key} value={key}>
                {state.label}
              </option>
            ))}
          </select>
          <select
            aria-label="严重程度过滤"
            value={severity}
            onChange={(event) => update('severity', event.target.value)}
          >
            <option value="">全部严重程度</option>
            <option>P1</option>
            <option>P2</option>
            <option>P3</option>
            <option value="ungraded">未分级</option>
          </select>
          {(query || status || severity) && (
            <button className="ic-button" onClick={() => setParams({})}>
              清除筛选
            </button>
          )}
        </div>
        <div className="ic-filter-note">
          当前搜索范围：故障 ID、服务、告警。日志、指标与 Trace
          检索暂未接入；现有 Fixture 未提供严重程度。
        </div>
        <IncidentTable
          incidents={incidents}
          loading={loading}
          unavailable={!snapshot}
        />
        <div className="ic-panel-footer">
          {snapshot ? `共 ${incidents.length} 条匹配记录` : '等待数据'}
          <span>时间使用本机时区 · 状态以记录时间为准</span>
        </div>
      </section>
    </>
  );
}
export function ConsolePendingPage() {
  const { pathname } = useLocation();
  const title =
    consoleNavigation.find((item) => item.path === pathname)?.label ?? '功能';
  return (
    <>
      <PageHeading
        title={title}
        subtitle="故障智巡 · AI 线上服务故障排查与处置平台"
      />
      <section className="ic-card ic-pending">
        <Construction size={32} />
        <span className="ic-badge ic-neutral">开发中</span>
        <h2>{title}尚未开放</h2>
        <p>本阶段提供运行总览与故障列表。此入口暂不执行任何业务操作。</p>
        <Link className="ic-button" to="/overview">
          返回运行总览 <ArrowRight size={14} />
        </Link>
      </section>
    </>
  );
}
