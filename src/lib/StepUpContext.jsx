import { createContext, useCallback, useContext, useRef, useState } from "react";
import { api, setStepUpToken } from "./api";

const StepUpContext = createContext(null);

export function StepUpProvider({ children }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const resolverRef = useRef(null);

  const requestStepUp = useCallback((actionReason = "confirm this action") => {
    setReason(actionReason);
    setError("");
    setOpen(true);
    return new Promise((resolve, reject) => {
      resolverRef.current = { resolve, reject };
    });
  }, []);

  const submit = useCallback(async (code) => {
    setBusy(true);
    setError("");
    try {
      const res = await api.post("/auth/step-up", { code });
      setStepUpToken(res.data.stepUpToken);
      setOpen(false);
      resolverRef.current?.resolve(res.data.stepUpToken);
    } catch (err) {
      setError(err.response?.data?.error?.message || "Invalid code. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  const cancel = useCallback(() => {
    setOpen(false);
    resolverRef.current?.reject(new Error("step-up cancelled"));
  }, []);

  return (
    <StepUpContext.Provider value={{ requestStepUp }}>
      {children}
      {open && (
        <StepUpModal reason={reason} error={error} busy={busy} onSubmit={submit} onCancel={cancel} />
      )}
    </StepUpContext.Provider>
  );
}

function StepUpModal({ reason, error, busy, onSubmit, onCancel }) {
  const [code, setCode] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-900">Re-verify identity</h2>
        <p className="mt-1 text-sm text-slate-600">
          This action ({reason}) requires you to confirm your MFA code again.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(code);
          }}
          className="mt-4 space-y-3"
        >
          <input
            autoFocus
            inputMode="numeric"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-center tracking-widest focus:border-blue-600"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || code.length < 6}
              className="flex-1 rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Confirm"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function useStepUp() {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error("useStepUp must be used within StepUpProvider");
  return ctx;
}
