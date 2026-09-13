import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/AuthContext";
import { defaultRouteForRole } from "../../lib/format";
import { Button, ErrorText, Input, apiErrorMessage } from "../../components/ui";

export default function Login() {
  const { login, verifyMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const explicitRedirect = location.state?.from?.pathname;

  const [stage, setStage] = useState("credentials"); // credentials | mfa
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleCredentials(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await login(username, password);
      if (res.mfaRequired) {
        setStage("mfa");
      } else {
        // Account has no MFA enrolled yet — mandatory for this system.
        navigate("/mfa-enroll", { replace: true, state: { from: { pathname: explicitRedirect } } });
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Invalid username or password."));
    } finally {
      setBusy(false);
    }
  }

  async function handleMfa(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const user = await verifyMfa(code);
      navigate(explicitRedirect || defaultRouteForRole(user.role), { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err, "Invalid MFA code."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto flex h-35 w-35 items-center justify-center rounded-lg ">
            
              </div>
         <h1 className="text-[#173B6C] text-5xl font-bold tracking-[0.08em] font-sans">
  CASETRACE
</h1>
          <p className="text-sm text-slate-500">Secure Legal &amp; Investigation Document System</p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          {stage === "credentials" ? (
            <form onSubmit={handleCredentials} className="space-y-4">
              <Input
                label="Username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
              <Input
                label="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <ErrorText>{error}</ErrorText>
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? "Signing in…" : "Continue"}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleMfa} className="space-y-4">
              <p className="text-sm text-slate-600">
                Enter the 6-digit code from your authenticator app.
              </p>
              <Input
                label="Authentication code"
                inputMode="numeric"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
              <ErrorText>{error}</ErrorText>
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? "Verifying…" : "Verify & sign in"}
              </Button>
              <button
                type="button"
                onClick={() => setStage("credentials")}
                className="w-full text-center text-xs text-slate-500 hover:underline"
              >
                Back
              </button>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Accounts are provisioned by your agency administrator. There is no public registration.
        </p>
      </div>
    </div>
  );
}
