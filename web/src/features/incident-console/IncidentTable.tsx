import { ArrowUpRight, FileSearch } from 'lucide-react';
import { formatTime, states, type Incident } from './model';

export function StateBadge({ status }: { status: string }) {
  const state = states[status] ?? { label: status, tone: 'neutral' };
  return (
    <span className={`ic-badge ic-${state.tone}`}>
      <i />
      {state.label}
    </span>
  );
}

export function IncidentTable({
  incidents,
  loading = false,
  unavailable = false,
  selectedId,
  onSelect,
  showDuration = false,
}: {
  incidents: Incident[];
  loading?: boolean;
  unavailable?: boolean;
  selectedId?: string;
  onSelect?: (incident: Incident) => void;
  showDuration?: boolean;
}) {
  const headings = [
    '编号',
    '服务',
    '故障主题 / 告警',
    '严重程度',
    '状态',
    '开始时间',
    ...(showDuration ? ['记录跨度'] : []),
    ...(onSelect ? ['操作'] : []),
  ];
  return (
    <div
      className="ic-table-scroll"
      tabIndex={0}
      aria-label="故障列表，可横向滚动"
    >
      <table className="ic-table">
        <thead>
          <tr>
            {headings.map((name) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 5 }, (_, i) => (
                <tr key={i}>
                  <td colSpan={headings.length}>
                    <div className="ic-skeleton" aria-label="正在加载故障" />
                  </td>
                </tr>
              ))
            : incidents.map((incident) => (
                <tr
                  key={incident.id}
                  className={selectedId === incident.id ? 'is-selected' : ''}
                >
                  <td>
                    <span className="ic-id">{incident.id}</span>
                    <small>Fixture 案例</small>
                  </td>
                  <td className="ic-service">{incident.service}</td>
                  <td>
                    <span className="ic-alert" title={incident.alert}>
                      {incident.alert}
                    </span>
                  </td>
                  <td>
                    {incident.severity ? (
                      <span
                        className={`ic-badge ic-${incident.severity === 'P1' ? 'red' : incident.severity === 'P2' ? 'amber' : 'blue'}`}
                      >
                        {incident.severity}
                      </span>
                    ) : (
                      <span className="ic-muted">未分级</span>
                    )}
                  </td>
                  <td>
                    <StateBadge status={incident.status} />
                  </td>
                  <td
                    className="ic-mono"
                    title={`${incident.startedAt}${incident.lastEventAt ? ` · 状态记录于 ${incident.lastEventAt}` : ''}`}
                  >
                    {formatTime(incident.startedAt)}
                  </td>
                  {showDuration && (
                    <td
                      className="ic-mono"
                      title="从故障开始到最近一条运行事件的记录跨度；不代表修复耗时"
                    >
                      {incident.lastEventAt &&
                      Date.parse(incident.lastEventAt) >=
                        Date.parse(incident.startedAt)
                        ? `${Math.max(1, Math.round((Date.parse(incident.lastEventAt) - Date.parse(incident.startedAt)) / 60000))} 分钟`
                        : '—'}
                    </td>
                  )}
                  {onSelect && (
                    <td>
                      <button
                        className="ic-table-action"
                        onClick={() => onSelect(incident)}
                        aria-label={`查看 ${incident.id} 首页详情`}
                      >
                        查看 <ArrowUpRight size={13} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
        </tbody>
      </table>
      {!loading && incidents.length === 0 && (
        <div className="ic-empty">
          <FileSearch size={28} />
          <strong>
            {unavailable ? '故障数据暂不可用' : '没有符合条件的故障'}
          </strong>
          <span>
            {unavailable
              ? '请恢复数据连接后重试。'
              : '尝试调整搜索、状态、严重程度或时间范围。'}
          </span>
        </div>
      )}
    </div>
  );
}
