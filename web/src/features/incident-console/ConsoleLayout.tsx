import { useEffect, useRef, useState } from 'react';
import {
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
} from 'react-router-dom';
import {
  Activity,
  Bell,
  Boxes,
  BarChart3,
  ChevronDown,
  Clock3,
  FlaskConical,
  LayoutDashboard,
  ListChecks,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import type { Snapshot } from './model';
import { INCIDENT_PRODUCT_VERSION } from './product-version';
import './console.css';

export const consoleNavigation = [
  { path: '/overview', label: '运行总览', icon: LayoutDashboard },
  { path: '/incidents', label: '故障中心', icon: TriangleAlert },
  { path: '/investigations', label: '调查任务', icon: ListChecks },
  { path: '/approvals', label: '审批中心', icon: ShieldCheck },
  { path: '/traces', label: '执行追踪', icon: BarChart3 },
  { path: '/evaluations', label: '评测中心', icon: FlaskConical },
  { path: '/services', label: '服务管理', icon: Boxes },
  { path: '/system-settings', label: '系统设置', icon: Settings2 },
];
interface ConsoleContext {
  snapshot: Snapshot | null;
  error: string;
  loading: boolean;
  range: string;
  refresh: () => void;
}
export const useConsole = () => useOutletContext<ConsoleContext>();

export function ConsoleLayout() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [health, setHealth] = useState<{
    api: boolean | null;
    database: boolean | null;
  }>({ api: null, database: null });
  const [range, setRange] = useState('all');
  const [query, setQuery] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const [logoutError, setLogoutError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const title =
    consoleNavigation.find((item) => item.path === location.pathname)?.label ??
    '运行总览';
  useEffect(() => {
    document.title = `${title} · 故障智巡`;
  }, [title]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const [data, healthResult] = await Promise.allSettled([
        api.get<Snapshot>('/api/incident-console'),
        api.get<{ checks: { database: boolean } }>('/api/health'),
      ]);
      if (!active) return;
      if (data.status === 'fulfilled') {
        setSnapshot(data.value);
        setError('');
      } else setError('故障数据获取失败，请检查 API 服务或重试。');
      setHealth(
        healthResult.status === 'fulfilled'
          ? { api: true, database: healthResult.value.checks.database }
          : { api: false, database: null },
      );
      setLoading(false);
      timer = setTimeout(refresh, 15_000);
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [revision]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const healthLabel = (value: boolean | null) =>
    value === null ? '未检测' : value ? '正常' : '不可用';
  return (
    <div className="incident-console">
      <a className="ic-skip" href="#console-content">
        跳至主要内容
      </a>
      <aside
        className={`ic-sidebar ${sidebarCollapsed ? 'is-collapsed' : ''}`}
        aria-label="主导航"
      >
        <NavLink
          to="/overview"
          className="ic-brand"
          aria-label="故障智巡 · 运行总览"
          title="故障智巡"
        >
          <span className="ic-brand-mark">
            <img
              src={`${import.meta.env.BASE_URL}icons/incident-mark.svg`}
              alt=""
            />
          </span>
          <span className="ic-brand-text">
            故障智巡<small>线上故障控制台</small>
          </span>
        </NavLink>
        <div className="ic-nav-label">工作空间</div>
        <nav>
          {consoleNavigation.map(({ path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              aria-label={label}
              title={label}
              className={({ isActive }) =>
                `ic-nav-item ${isActive ? 'is-active' : ''}`
              }
            >
              <Icon size={18} />
              <span>{label}</span>
              {['/services', '/system-settings'].includes(path) && (
                <small>开发中</small>
              )}
            </NavLink>
          ))}
        </nav>
        <section className="ic-system">
          <h2 title="系统状态">
            <Activity size={14} />
            <span>系统状态</span>
          </h2>
          {[
            ['API 服务', health.api],
            ['Agent Runtime', null],
            ['工具执行器', null],
            ['数据库', health.database],
          ].map(([name, value]) => (
            <div
              key={String(name)}
              title={`${name}：${healthLabel(value as boolean | null)}`}
            >
              <span className="ic-system-name">{name}</span>
              <span
                className={`ic-health ${value === true ? 'ic-green' : value === false ? 'ic-red' : ''}`}
              >
                <i />
                <span>{healthLabel(value as boolean | null)}</span>
              </span>
            </div>
          ))}
          <p>Runtime 与执行器尚无独立健康探针</p>
        </section>
      </aside>
      <div className={`ic-workspace ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
        <header className="ic-topbar">
          <button
            className="ic-icon-button ic-sidebar-toggle"
            aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            <Menu size={18} />
          </button>
          <form
            className="ic-global-search"
            onSubmit={(event) => {
              event.preventDefault();
              navigate(
                `/incidents${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`,
              );
            }}
          >
            <Search size={17} />
            <input
              ref={searchRef}
              aria-label="全局搜索"
              placeholder="搜索故障、服务、日志、指标或 Trace..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>Ctrl K</kbd>
          </form>
          <span className="ic-runtime" title="当前尚无独立 Runtime 健康探针">
            <i />
            Agent Runtime <b>未检测</b>
          </span>
          <label className="ic-range">
            <Clock3 size={15} />
            <span className="ic-sr-only">时间范围</span>
            <select
              aria-label="时间范围"
              value={range}
              onChange={(event) => setRange(event.target.value)}
            >
              <option value="all">全部时间</option>
              <option value="24">最近 24 小时</option>
              <option value="168">最近 7 天</option>
            </select>
          </label>
          <details className="ic-popover">
            <summary aria-label="通知">
              <Bell size={18} />
            </summary>
            <div className="ic-popover-panel">
              <strong>通知</strong>
              <p>通知服务尚未接入。</p>
              <small>故障事件可在运行总览中查看。</small>
            </div>
          </details>
          <details className="ic-popover ic-user">
            <summary aria-label="用户菜单">
              <span className="ic-avatar">
                <UserRound size={17} />
              </span>
              <span>{user?.display_name || user?.username || '用户'}</span>
              <ChevronDown size={13} />
            </summary>
            <div className="ic-popover-panel">
              <strong>{user?.username}</strong>
              <p>{user?.role === 'admin' ? '管理员' : '成员'}</p>
              <button
                className="ic-button"
                onClick={() => {
                  void logout()
                    .then(() => navigate('/login'))
                    .catch(() => setLogoutError('退出失败，请重试'));
                }}
              >
                退出登录
              </button>
              {logoutError && <p role="alert">{logoutError}</p>}
            </div>
          </details>
        </header>
        <main id="console-content" className="ic-main">
          <Outlet
            context={
              {
                snapshot,
                error,
                loading,
                range,
                refresh: () => setRevision((value) => value + 1),
              } satisfies ConsoleContext
            }
          />
        </main>
        <footer className="ic-footer">
          <span>故障智巡 · {INCIDENT_PRODUCT_VERSION}</span>
          <span>证据 · 审批 · Trace</span>
        </footer>
      </div>
    </div>
  );
}
