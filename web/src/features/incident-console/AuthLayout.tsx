import type { ReactNode } from 'react';
import {
  Activity,
  ClipboardCheck,
  History,
  SearchCheck,
  ShieldCheck,
} from 'lucide-react';

const capabilities = [
  {
    icon: SearchCheck,
    title: '证据驱动调查',
    lines: ['自动采集多源证据', '辅助定位故障根因'],
    tone: 'blue',
  },
  {
    icon: ShieldCheck,
    title: '人工审批控制',
    lines: ['关键操作需人工审批', '把变更留在人手中'],
    tone: 'amber',
  },
  {
    icon: History,
    title: '执行追踪回放',
    lines: ['记录调查与处置过程', '支持问题追溯复盘'],
    tone: 'green',
  },
] as const;

const workflow = [
  { label: '取证', icon: SearchCheck },
  { label: '诊断', icon: Activity },
  { label: '审批', icon: ClipboardCheck },
  { label: '追踪', icon: History },
] as const;

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="incident-auth">
      <header className="incident-auth__header">
        <div className="incident-auth__brand">
          <img
            src={`${import.meta.env.BASE_URL}icons/incident-mark.svg`}
            alt=""
          />
          <span className="incident-auth__brand-name">故障智巡</span>
          <span className="incident-auth__brand-divider" aria-hidden="true" />
          <span className="incident-auth__brand-subtitle">
            AI 线上服务故障排查与处置平台
          </span>
        </div>
      </header>

      <main className="incident-auth__main">
        <section
          className="incident-auth__story"
          aria-labelledby="incident-auth-title"
        >
          <div className="incident-auth__copy">
            <h1 id="incident-auth-title">
              线上故障调查、证据与诊断
              <span>集中呈现，处置由人工把关</span>
            </h1>
            <p>
              故障智巡记录 Agent
              调查过程、证据、诊断与审批结果。关键处置需人工确认，事件记录支持追踪与回放。
            </p>
          </div>

          <div className="incident-auth__capabilities" aria-label="平台能力">
            {capabilities.map(({ icon: Icon, title, lines, tone }) => (
              <article className="incident-auth__capability" key={title}>
                <span className={`incident-auth__capability-icon is-${tone}`}>
                  <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <h2>{title}</h2>
                <p>{lines[0]}</p>
                <p>{lines[1]}</p>
              </article>
            ))}
          </div>

          <div
            className="incident-auth__preview"
            aria-label="故障调查处置流程预览"
          >
            <div className="incident-auth__preview-heading">
              <span className="incident-auth__preview-mark">
                <Activity size={16} aria-hidden="true" />
              </span>
              <span>
                <strong>故障处置工作流</strong>
                <small>从证据到行动，每一步都有记录</small>
              </span>
              <span className="incident-auth__preview-live">流程示意</span>
            </div>
            <div className="incident-auth__workflow" aria-hidden="true">
              {workflow.map(({ label, icon: Icon }, index) => (
                <div className="incident-auth__workflow-step" key={label}>
                  <span className="incident-auth__workflow-icon">
                    <Icon size={16} strokeWidth={1.8} />
                  </span>
                  <span>{label}</span>
                  {index < workflow.length - 1 && (
                    <span className="incident-auth__workflow-link" />
                  )}
                </div>
              ))}
            </div>
            <div className="incident-auth__preview-foot">
              <span>只读取证</span>
              <span>人工审批</span>
              <span>模拟执行</span>
            </div>
          </div>
        </section>

        <section className="incident-auth__form-region" aria-label="账户访问">
          {children}
        </section>
      </main>

      <footer className="incident-auth__footer">
        <div className="incident-auth__footer-brand">
          <span>故障智巡</span>
          <span className="incident-auth__footer-divider" aria-hidden="true" />
          <span>v0.2.0</span>
        </div>
        <span>© {new Date().getFullYear()} 故障智巡</span>
      </footer>
    </div>
  );
}

export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="incident-auth__card">
      <div className="incident-auth__card-heading">
        <div className="incident-auth__card-mark">
          <img
            src={`${import.meta.env.BASE_URL}icons/incident-mark.svg`}
            alt=""
          />
        </div>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {children}
      <div className="incident-auth__security-note">
        <ShieldCheck size={17} strokeWidth={1.8} aria-hidden="true" />
        <span>仅限授权人员访问，请妥善保管账号信息</span>
      </div>
    </div>
  );
}

export function authErrorMessage(
  error: unknown,
  action: 'login' | 'setup' | 'register',
): string {
  if (
    action === 'login' &&
    error instanceof Error &&
    error.message.toLowerCase() === 'unauthorized'
  ) {
    return '账号或密码错误，请重新输入。';
  }

  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : null;

  if (status === 0) return '无法连接服务器，请检查网络后重试。';
  if (status === 408) return '请求超时，请稍后重试。';
  if (action === 'login' && status === 429) return '尝试次数过多，请稍后再试。';
  if (action === 'login' && (status === 401 || status === 403)) {
    return '账号或密码错误，请重新输入。';
  }
  if (action === 'setup' && status === 403) {
    return '系统已完成初始化，请前往登录。';
  }
  if (action === 'register' && status === 403)
    return '邀请码无效或已失效，请核对后重试。';
  if (action === 'setup' && status === 400)
    return '账号信息不符合要求，请检查后重试。';
  if (action === 'register' && status === 400)
    return '注册信息无效，请检查账号、密码和邀请码。';

  return action === 'login'
    ? '登录暂时无法完成，请稍后重试。'
    : action === 'setup'
      ? '初始化暂时无法完成，请稍后重试。'
      : '注册暂时无法完成，请稍后重试。';
}
