import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, Loader2, LockKeyhole, UserRound } from 'lucide-react';
import { useAuthStore } from '../stores/auth';
import { LogoLoading } from '../components/common/LogoLoading';
import { api } from '../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  AuthCard,
  AuthLayout,
  authErrorMessage,
} from '../features/incident-console/AuthLayout';
import '../features/incident-console/auth.css';

interface RegisterStatus {
  allowRegistration: boolean;
  requireInviteCode: boolean;
}

type Tab = 'login' | 'register';

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(
    searchParams.get('tab') === 'register' ? 'register' : 'login',
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const register = useAuthStore((state) => state.register);
  const initialized = useAuthStore((state) => state.initialized);
  const checkStatus = useAuthStore((state) => state.checkStatus);

  useEffect(() => {
    document.title = '管理员登录 · 故障智巡';
  }, []);

  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regDisplayName, setRegDisplayName] = useState('');
  const [regInviteCode, setRegInviteCode] = useState('');
  const [regStatus, setRegStatus] = useState<RegisterStatus>({
    allowRegistration: true,
    requireInviteCode: true,
  });

  useEffect(() => {
    if (initialized === null) {
      checkStatus();
    } else if (initialized === false) {
      navigate('/setup', { replace: true });
    }
  }, [initialized, checkStatus, navigate]);

  useEffect(() => {
    api
      .get<RegisterStatus>('/api/auth/register/status')
      .then(setRegStatus)
      .catch(() => {
        setRegStatus({ allowRegistration: true, requireInviteCode: true });
      });
  }, []);

  const switchTab = (next: Tab) => {
    setTab(next);
    setError('');
    setShowPassword(false);
  };

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    setError('');
    setLoading(true);

    try {
      await login(loginUsername.trim(), loginPassword);
      const state = useAuthStore.getState();
      if (state.user?.role === 'admin' && state.setupStatus?.needsSetup) {
        navigate('/setup/providers');
        return;
      }
      const mustChange = state.user?.must_change_password;
      navigate(mustChange ? '/settings' : '/overview');
    } catch (loginError) {
      setError(authErrorMessage(loginError, 'login'));
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    setError('');

    if (!/^[a-zA-Z0-9_]{3,32}$/.test(regUsername)) {
      setError('用户名须为 3-32 位字母、数字或下划线。');
      return;
    }
    if (regPassword.length < 8) {
      setError('密码长度不能少于 8 位。');
      return;
    }
    if (regPassword.length > 128) {
      setError('密码长度不能超过 128 位。');
      return;
    }

    setLoading(true);
    try {
      const payload: {
        username: string;
        password: string;
        display_name?: string;
        invite_code?: string;
      } = {
        username: regUsername,
        password: regPassword,
        display_name: regDisplayName || undefined,
      };
      if (regStatus.requireInviteCode || regInviteCode.trim()) {
        payload.invite_code = regInviteCode;
      }
      await register(payload);
      const state = useAuthStore.getState();
      if (state.user?.role === 'admin' && state.setupStatus?.needsSetup) {
        navigate('/setup/providers');
        return;
      }
      navigate(
        state.user?.must_change_password ? '/settings' : '/setup/channels',
      );
    } catch (registerError) {
      setError(authErrorMessage(registerError, 'register'));
    } finally {
      setLoading(false);
    }
  };

  if (initialized !== true) {
    return <LogoLoading full />;
  }

  return (
    <AuthLayout>
      <AuthCard
        title={tab === 'login' ? '管理员登录' : '注册账户'}
        description="故障智巡 · AI 线上服务故障排查与处置平台"
      >
        {error && (
          <div className="incident-auth__error" role="alert" aria-live="polite">
            {error}
          </div>
        )}

        {tab === 'login' ? (
          <form onSubmit={handleLogin}>
            <div className="incident-auth__field">
              <label
                className="incident-auth__field-label"
                htmlFor="login-username"
              >
                用户名
              </label>
              <div className="incident-auth__input-wrap">
                <UserRound
                  className="incident-auth__input-icon"
                  size={17}
                  aria-hidden="true"
                />
                <Input
                  id="login-username"
                  className="incident-auth__input"
                  type="text"
                  value={loginUsername}
                  onChange={(event) => setLoginUsername(event.target.value)}
                  placeholder="请输入用户名"
                  required
                  autoFocus
                  autoComplete="username"
                  aria-label="用户名"
                />
              </div>
            </div>

            <div className="incident-auth__field">
              <label
                className="incident-auth__field-label"
                htmlFor="login-password"
              >
                密码
              </label>
              <div className="incident-auth__input-wrap">
                <LockKeyhole
                  className="incident-auth__input-icon"
                  size={17}
                  aria-hidden="true"
                />
                <Input
                  id="login-password"
                  className="incident-auth__input"
                  type={showPassword ? 'text' : 'password'}
                  value={loginPassword}
                  onChange={(event) => setLoginPassword(event.target.value)}
                  placeholder="请输入密码"
                  required
                  autoComplete="current-password"
                  aria-label="密码"
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

            <Button
              className="incident-auth__submit w-full"
              type="submit"
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {loading ? '正在登录…' : '登录'}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleRegister}>
            {regStatus.requireInviteCode && (
              <div className="incident-auth__field">
                <label
                  className="incident-auth__field-label"
                  htmlFor="reg-invite"
                >
                  邀请码
                </label>
                <Input
                  id="reg-invite"
                  className="incident-auth__input"
                  value={regInviteCode}
                  onChange={(event) => setRegInviteCode(event.target.value)}
                  placeholder="请输入邀请码"
                  required
                  autoFocus
                  autoComplete="off"
                />
              </div>
            )}
            <div className="incident-auth__field">
              <label
                className="incident-auth__field-label"
                htmlFor="reg-username"
              >
                用户名
              </label>
              <Input
                id="reg-username"
                className="incident-auth__input"
                value={regUsername}
                onChange={(event) => setRegUsername(event.target.value)}
                placeholder="3-32 位字母、数字或下划线"
                required
                autoFocus={!regStatus.requireInviteCode}
                autoComplete="username"
              />
            </div>
            <div className="incident-auth__field">
              <label
                className="incident-auth__field-label"
                htmlFor="reg-display"
              >
                显示名称（可选）
              </label>
              <Input
                id="reg-display"
                className="incident-auth__input"
                value={regDisplayName}
                onChange={(event) => setRegDisplayName(event.target.value)}
                placeholder="留空则使用用户名"
                autoComplete="name"
              />
            </div>
            <div className="incident-auth__field">
              <label
                className="incident-auth__field-label"
                htmlFor="reg-password"
              >
                密码
              </label>
              <Input
                id="reg-password"
                className="incident-auth__input"
                type="password"
                value={regPassword}
                onChange={(event) => setRegPassword(event.target.value)}
                placeholder="至少 8 位"
                required
                autoComplete="new-password"
              />
            </div>
            <Button
              className="incident-auth__submit w-full"
              type="submit"
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {loading ? '正在注册…' : '注册账户'}
            </Button>
          </form>
        )}

        {regStatus.allowRegistration && (
          <p className="incident-auth__register">
            {tab === 'login' ? '需要创建普通账户？' : '已有账户？'}
            <button
              className="incident-auth__register-link"
              type="button"
              onClick={() => switchTab(tab === 'login' ? 'register' : 'login')}
            >
              {tab === 'login' ? '去注册' : '返回登录'}
            </button>
          </p>
        )}
      </AuthCard>
    </AuthLayout>
  );
}
