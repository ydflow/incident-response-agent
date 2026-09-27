import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  UserRound,
} from 'lucide-react';
import { LogoLoading } from '../components/common/LogoLoading';
import { useAuthStore } from '../stores/auth';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  AuthCard,
  AuthLayout,
  authErrorMessage,
} from '../features/incident-console/AuthLayout';
import '../features/incident-console/auth.css';

export function SetupPage() {
  const navigate = useNavigate();
  const { initialized, authenticated, setupAdmin, checkStatus } =
    useAuthStore();

  useEffect(() => {
    if (initialized === null) checkStatus();
  }, [initialized, checkStatus]);

  useEffect(() => {
    if (initialized === true && !authenticated) {
      navigate('/login', { replace: true });
    }
  }, [initialized, authenticated, navigate]);

  if (initialized === true && authenticated) {
    return <Navigate to="/setup/providers" replace />;
  }

  if (initialized !== false) {
    return <LogoLoading full />;
  }

  return (
    <AuthLayout>
      <AuthCard
        title="初始化故障智巡"
        description="创建管理员账号，完成后进入系统配置。"
      >
        <CreateAdminStep
          onDone={() => navigate('/setup/providers', { replace: true })}
          setupAdmin={setupAdmin}
        />
      </AuthCard>
    </AuthLayout>
  );
}

function CreateAdminStep({
  onDone,
  setupAdmin,
}: {
  onDone: () => void;
  setupAdmin: (username: string, password: string) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;

    if (!username.trim()) {
      setError('请填写用户名。');
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      setError('用户名须为 3-32 位字母、数字或下划线。');
      return;
    }
    if (password.length < 8) {
      setError('密码至少需要 8 位。');
      return;
    }
    if (password.length > 128) {
      setError('密码不能超过 128 位。');
      return;
    }
    if (password !== confirmPwd) {
      setError('两次输入的密码不一致。');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await setupAdmin(username, password);
      onDone();
    } catch (setupError) {
      const status =
        typeof setupError === 'object' &&
        setupError !== null &&
        'status' in setupError
          ? Number((setupError as { status?: unknown }).status)
          : NaN;
      setError(authErrorMessage(setupError, 'setup'));
      if (status === 403) {
        window.setTimeout(() => navigate('/login', { replace: true }), 1800);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <p className="incident-auth__setup-intro">
        首次使用请创建管理员账号，随后继续配置服务接入。
      </p>

      {error && (
        <div className="incident-auth__error" role="alert" aria-live="polite">
          {error}
        </div>
      )}

      <div className="incident-auth__field">
        <label className="incident-auth__field-label" htmlFor="setup-username">
          管理员用户名
        </label>
        <div className="incident-auth__input-wrap">
          <UserRound
            className="incident-auth__input-icon"
            size={17}
            aria-hidden="true"
          />
          <Input
            id="setup-username"
            className="incident-auth__input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="3-32 位字母、数字或下划线"
            required
            autoFocus
            autoComplete="username"
            aria-label="管理员用户名"
          />
        </div>
      </div>

      <div className="incident-auth__field">
        <label className="incident-auth__field-label" htmlFor="setup-password">
          设置密码
        </label>
        <div className="incident-auth__input-wrap">
          <LockKeyhole
            className="incident-auth__input-icon"
            size={17}
            aria-hidden="true"
          />
          <Input
            id="setup-password"
            className="incident-auth__input"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 8 位"
            required
            autoComplete="new-password"
            aria-label="设置管理员密码"
          />
          <button
            className="incident-auth__password-toggle"
            type="button"
            aria-label={showPassword ? '隐藏密码' : '显示密码'}
            aria-pressed={showPassword}
            onClick={() => setShowPassword((visible) => !visible)}
          >
            {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>
      </div>

      <div className="incident-auth__field">
        <label
          className="incident-auth__field-label"
          htmlFor="setup-password-confirm"
        >
          确认密码
        </label>
        <div className="incident-auth__input-wrap">
          <LockKeyhole
            className="incident-auth__input-icon"
            size={17}
            aria-hidden="true"
          />
          <Input
            id="setup-password-confirm"
            className="incident-auth__input"
            type={showConfirm ? 'text' : 'password'}
            value={confirmPwd}
            onChange={(event) => setConfirmPwd(event.target.value)}
            placeholder="再次输入密码"
            required
            autoComplete="new-password"
            aria-label="确认管理员密码"
          />
          <button
            className="incident-auth__password-toggle"
            type="button"
            aria-label={showConfirm ? '隐藏确认密码' : '显示确认密码'}
            aria-pressed={showConfirm}
            onClick={() => setShowConfirm((visible) => !visible)}
          >
            {showConfirm ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>
      </div>

      <Button
        className="incident-auth__submit w-full"
        type="submit"
        disabled={saving}
      >
        {saving ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : null}
        {saving ? '正在创建…' : '创建管理员并继续'}
        {!saving && <ChevronRight className="size-4" aria-hidden="true" />}
      </Button>
    </form>
  );
}
