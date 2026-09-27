export interface Incident {
  id: string;
  service: string;
  alert: string;
  startedAt: string;
  severity: 'P1' | 'P2' | 'P3' | null;
  status: string;
  lastEventAt: string | null;
  source: 'fixture';
}
export interface AgentEvent {
  id: string;
  incidentId: string;
  type: string;
  timestamp: string;
  status: string | null;
  tool: string | null;
}
export interface Snapshot {
  incidents: Incident[];
  events: AgentEvent[];
  updatedAt: string;
  historyAccess: boolean;
  source: string;
  warnings: string[];
}
export const states: Record<string, { label: string; tone: string }> = {
  INVESTIGATING: { label: '调查中', tone: 'blue' },
  AWAITING_APPROVAL: { label: '待审批', tone: 'amber' },
  RESOLVED: { label: '已解决', tone: 'green' },
  ESCALATED: { label: '已升级', tone: 'orange' },
  FAILED: { label: '失败', tone: 'red' },
  DIAGNOSED: { label: '已诊断', tone: 'blue' },
  RECEIVED: { label: '已接收', tone: 'neutral' },
  NOT_RUN: { label: '未调查', tone: 'neutral' },
  UNAVAILABLE: { label: '无查看权限', tone: 'neutral' },
};
export const eventLabels: Record<string, string> = {
  IncidentCreated: '故障创建',
  StatusChanged: '状态变更',
  ToolCalled: '调用工具',
  ToolResult: '工具返回',
  EvidenceCollected: '采集证据',
  DiagnosisCreated: '生成根因分析',
  ApprovalRequested: '发起审批',
  ApprovalDecided: '审批完成',
  ActionExecuted: '执行操作',
  ToolFailed: '工具执行失败',
};
export function formatTime(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
export function inRange(value: string, range: string, now: number) {
  return (
    range === 'all' || Date.parse(value) >= now - Number(range) * 60 * 60 * 1000
  );
}
