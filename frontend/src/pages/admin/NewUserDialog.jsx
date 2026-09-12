import { useState } from "react";
import { api } from "../../lib/api";
import { CLASSIFICATIONS, ROLES, titleCase } from "../../lib/format";
import { Button, Card, ErrorText, Input, Select, apiErrorMessage } from "../../components/ui";
import { OrgPicker, JurisdictionPicker } from "../../components/ReferencePicker";

// Admin-tier roles are appointed via /governance proposals, not this form —
// the backend rejects them here (see users.service.js ADMIN_TIER_ROLES).
const ADMIN_TIER_ROLES = new Set(["SYSTEM_ADMIN", "SECURITY_ADMIN", "ORG_ADMIN"]);
const PROVISIONABLE_ROLES = ROLES.filter((r) => !ADMIN_TIER_ROLES.has(r));

export default function NewUserDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    role: PROVISIONABLE_ROLES[0],
    clearance: "RESTRICTED",
    jurisdictionId: "",
    orgId: "",
    badgeId: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api.post("/users", form);
      setCreated(res.data);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not create user."));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 px-4">
        <Card className="w-full max-w-md p-6">
          <h2 className="text-lg font-semibold text-slate-900">User provisioned</h2>
          <p className="mt-2 text-sm text-slate-600">
            Share this one-time activation link with {created.user.fullName} so they can set a
            password and enroll MFA.
          </p>
          <p className="mt-3 break-all rounded-md bg-slate-50 p-3 font-mono text-xs">
            {`${window.location.origin}/activate?token=${created.activationToken}`}
          </p>
          <Button className="mt-4 w-full" onClick={() => onCreated(created)}>
            Done
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-900">Provision new user</h2>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input label="Full name" required value={form.fullName} onChange={(e) => set("fullName", e.target.value)} />
            <Input
              label="Email"
              type="email"
              required
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Role" value={form.role} onChange={(e) => set("role", e.target.value)}>
              {PROVISIONABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ))}
            </Select>
            <Select label="Clearance" value={form.clearance} onChange={(e) => set("clearance", e.target.value)}>
              {CLASSIFICATIONS.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <JurisdictionPicker required value={form.jurisdictionId} onChange={(v) => set("jurisdictionId", v)} />
            <OrgPicker required value={form.orgId} onChange={(v) => set("orgId", v)} />
          </div>
          <Input
            label="Badge ID (optional)"
            value={form.badgeId}
            onChange={(e) => set("badgeId", e.target.value)}
          />
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Provision user"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
