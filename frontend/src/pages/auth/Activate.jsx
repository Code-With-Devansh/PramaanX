import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { Button, Card, ErrorText, Input, apiErrorMessage } from "../../components/ui";

// Consumes the one-time activation token an admin shares with a newly
// provisioned user (see NewUserDialog) to set their first password.
// POST /activate is unauthenticated — there's no session yet.
export default function Activate() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [activationToken, setActivationToken] = useState(searchParams.get("token") || "");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/activate", { activationToken, newPassword });
      setDone(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not activate this account. The link may be invalid or expired."));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
        <Card className="w-full max-w-sm p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Account activated</h1>
          <p className="mt-2 text-sm text-slate-600">
            Your password has been set. Sign in to continue — you'll be asked to enroll MFA.
          </p>
          <Button className="mt-4 w-full" onClick={() => navigate("/login", { replace: true })}>
            Go to sign in
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-blue-700 text-lg font-bold text-white">
            DM
          </div>
          <h1 className="text-lg font-semibold text-slate-900">Activate your account</h1>
          <p className="text-sm text-slate-500">Set a password to finish setting up your access.</p>
        </div>
        <Card className="p-6">
          <form onSubmit={submit} className="space-y-4">
            <Input
              label="Activation token"
              value={activationToken}
              onChange={(e) => setActivationToken(e.target.value)}
              required
            />
            <Input
              label="New password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
            <Input
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
            <p className="text-xs text-slate-400">
              At least 8 characters, with an uppercase letter, a lowercase letter, and a number.
            </p>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Activating…" : "Activate account"}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
