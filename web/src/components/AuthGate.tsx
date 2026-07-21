import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { LockKeyhole, ShieldAlert } from "lucide-react";
import { api, type AuthStatus } from "../api/client.js";

interface AuthGateProps {
  readonly children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps): JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [username, setUsername] = useState("mak");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getAuthStatus()
      .then(setStatus)
      .catch((cause: Error) => setError(cause.message));
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    api.login(username, password)
      .then(() => api.getAuthStatus())
      .then(setStatus)
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  if (status?.authenticated === true) {
    return <>{children}</>;
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-label="Nocheh private login">
        <div className="auth-mark">
          <LockKeyhole size={22} aria-hidden="true" />
        </div>
        <h1>Nocheh Brain</h1>
        <p>Private memory, tasks, routines, and strategy dashboard.</p>

        {status?.configured === false ? (
          <div className="auth-warning">
            <ShieldAlert size={16} aria-hidden="true" />
            <div>
              <b>Auth is not configured</b>
              <span>Set `APP_AUTH_USERNAME` and `APP_AUTH_PASSWORD` in `.env`, then restart the server.</span>
            </div>
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <label htmlFor="auth-username">Username</label>
            <input
              id="auth-username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {error !== null && <div className="notice error">{error}</div>}
            <button className="action" disabled={busy || username.trim().length === 0 || password.length === 0}>
              {busy ? "Unlocking" : "Unlock app"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
