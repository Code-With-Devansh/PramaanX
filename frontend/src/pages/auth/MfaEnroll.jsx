import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, setAccessToken } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { defaultRouteForRole } from "../../lib/format";
import { Button, Card, ErrorText, Input, Spinner, apiErrorMessage } from "../../components/ui";

// Runs right after login when the account has no MFA enrolled yet — mandatory
// for every role in this system, so there's no "skip" option.
export default function MfaEnroll() {
  const navigate = useNavigate();
  const location = useLocation();
  const explicitRedirect = location.state?.from?.pathname;
  const { refreshMe } = useAuth();

  const [loading, setLoading] = useState(true);
  const [secret, setSecret] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [backupCodes, setBackupCodes] = useState(null);
  const [postEnrollRedirect, setPostEnrollRedirect] = useState("/");

  useEffect(() => {
    (async () => {
      try {
        const res = await api.post("/auth/mfa/enroll/start");
        setSecret(res.data.secret);
        setQrDataUrl(res.data.qrDataUrl || res.data.qrCode || null);
      } catch (err) {
        setError(apiErrorMessage(err, "Could not start MFA enrollment."));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleVerify(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api.post("/auth/mfa/enroll/verify", { code });
      setAccessToken(res.data.accessToken);
      const me = await refreshMe();
      const target = explicitRedirect || defaultRouteForRole(me.role);
      if (res.data.backUpCodes?.length) {
        setPostEnrollRedirect(target);
        setBackupCodes(res.data.backUpCodes);
      } else {
        navigate(target, { replace: true });
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Invalid code. Try again."));
    } finally {
      setBusy(false);
    }
  }

  if (backupCodes) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
        <Card className="w-full max-w-sm p-6">
          <h1 className="text-lg font-semibold text-slate-900">Save your backup codes</h1>
          <p className="mt-1 text-sm text-slate-600">
            Store these somewhere safe. Each can be used once if you lose access to your
            authenticator.
          </p>
          <ul className="mt-4 grid grid-cols-2 gap-2 rounded-md bg-slate-50 p-3 font-mono text-sm">
            {backupCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <Button className="mt-4 w-full" onClick={() => navigate(postEnrollRedirect, { replace: true })}>
            I've saved these — continue
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-slate-900">Set up multi-factor authentication</h1>
        <p className="mt-1 text-sm text-slate-600">
          Required before you can access the system. Scan the QR code with an authenticator
          app (e.g. Google Authenticator, Authy).
        </p>

        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="MFA enrollment QR code" className="mx-auto h-40 w-40" />
            ) : secret ? (
              <p className="rounded-md bg-slate-50 p-3 text-center font-mono text-sm break-all">
                {secret}
              </p>
            ) : null}

            <form onSubmit={handleVerify} className="space-y-3">
              <Input
                label="Enter the 6-digit code to confirm"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
              <ErrorText>{error}</ErrorText>
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? "Verifying…" : "Verify & finish setup"}
              </Button>
            </form>
          </div>
        )}
      </Card>
    </div>
  );
}
