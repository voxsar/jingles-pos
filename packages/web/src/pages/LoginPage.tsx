import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export default function LoginPage() {
  const navigate = useNavigate();
  const { clearError, error, isLoading, login, user } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    clearError();
  }, [clearError]);

  useEffect(() => {
    if (user) {
      navigate('/', { replace: true });
    }
  }, [navigate, user]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      await login(identifier, password);
      navigate('/', { replace: true });
    } catch {
      // Error state is surfaced by the auth context.
    }
  }

  return (
    <div className="screen-fill workstation-app login-screen auth-screen">
      <div className="bg-layer bg-layer-gradient" />
      <div className="bg-layer bg-layer-aurora" />

      <div className="login-card glass-panel auth-login-card">
        <div className="brand-row">
          <div className="brand-mark">JP</div>
          <div>
            <div className="brand-title">Jingles POS</div>
            <div className="brand-subtitle">Inventory-shaped auth, local-first workstation</div>
          </div>
        </div>

        <div className="login-heading">Sign in</div>
        <div className="login-copy">
          Use the same session flow as Inventory, then continue into the local workstation and sync out later.
        </div>

        <div className="auth-pill-row">
          <span className="status-pill">SQLite local records</span>
          <span className="status-pill">Outbox replay sync</span>
          <span className="status-pill">Desktop-first search</span>
        </div>

        {error && (
          <div className="inline-alert error">
            {error}
          </div>
        )}

        <form className="auth-form-stack" onSubmit={handleSubmit}>
          <LabelBlock label="Email or employee code">
            <input
              autoFocus
              className="glass-input"
              name="identifier"
              placeholder="muslim.abdullah@jingles.local or E1042"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
            />
          </LabelBlock>

          <LabelBlock label="Password">
            <input
              className="glass-input"
              type="password"
              name="password"
              placeholder="Enter your password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </LabelBlock>

          <button className="btn-primary login-submit" disabled={isLoading} type="submit">
            {isLoading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <div className="login-footer">
          <span>Sessions stay local on the desktop.</span>
          <span>Sync remains a separate outbox process.</span>
        </div>
      </div>
    </div>
  );
}

function LabelBlock(props: { label: string; children: ReactNode }) {
  return (
    <label className="label-block">
      <span className="label-copy">{props.label}</span>
      {props.children}
    </label>
  );
}
