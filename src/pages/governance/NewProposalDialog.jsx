import { useState } from "react";
import { api } from "../../lib/api";
import { ABAC_POLICY_KEYS, POOL_TYPES, SUDO_ACTION_TYPES, titleCase } from "../../lib/format";
import { Button, ErrorText, Input, Select, apiErrorMessage } from "../../components/ui";
import UserPicker from "../../components/UserPicker";
import { OrgPicker } from "../../components/ReferencePicker";

const ACTION_HELP = {
  APPOINT_ORG_ADMIN: "Adds a user to an org's ORG_ADMIN pool. Requires that org's own quorum plus a Security Admin co-sign.",
  REMOVE_ORG_ADMIN: "Removes a user from an org's ORG_ADMIN pool. Same quorum as appointing.",
  APPOINT_SYSTEM_ADMIN: "Adds a user to the top-tier SYSTEM_ADMIN pool. Requires SYSTEM_ADMIN quorum plus a Security Admin co-sign.",
  REMOVE_SYSTEM_ADMIN: "Removes a user from the SYSTEM_ADMIN pool. Cannot drop the pool below its own quorum.",
  CHANGE_POOL_THRESHOLD: "Changes a pool's k (votes required). Requires that pool's quorum plus a Security Admin co-sign.",
  ONBOARD_ORG: "Stands up a starting ORG_ADMIN pool for an org that already exists in Reference Data (create it there first). Governed by the SYSTEM_ADMIN pool.",
  CHANGE_ABAC_POLICY: "Overrides part of the access-control policy (clearance ranks, role permissions, aliases). Security Admin pool proposes; System Admins must acknowledge k-of-N.",
  POOL_REINSTATEMENT: "Tier-2 recovery: reconstitutes an ORG_ADMIN or SECURITY_ADMIN pool that fell below its own quorum. Requires SYSTEM_ADMIN quorum plus k-of-P active-auditor votes.",
};

export default function NewProposalDialog({ onClose, onCreated }) {
  const [actionType, setActionType] = useState(SUDO_ACTION_TYPES[0]);
  const [org, setOrg] = useState("");
  const [userId, setUserId] = useState("");
  const [poolType, setPoolType] = useState("ORG_ADMIN");
  const [k, setK] = useState("");
  const [memberIds, setMemberIds] = useState([]);
  const [policyText, setPolicyText] = useState("{\n  \n}");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function buildPayload() {
    switch (actionType) {
      case "APPOINT_ORG_ADMIN":
      case "REMOVE_ORG_ADMIN":
        if (!org.trim()) throw new Error("Org is required.");
        if (!userId) throw new Error("Select a user.");
        return { org: org.trim(), userId };
      case "APPOINT_SYSTEM_ADMIN":
      case "REMOVE_SYSTEM_ADMIN":
        if (!userId) throw new Error("Select a user.");
        return { userId };
      case "CHANGE_POOL_THRESHOLD": {
        if (!k || !Number.isInteger(Number(k))) throw new Error("k must be an integer.");
        if (poolType === "ORG_ADMIN" && !org.trim()) throw new Error("Org is required for an ORG_ADMIN pool.");
        return { poolType, org: poolType === "ORG_ADMIN" ? org.trim() : undefined, k: Number(k) };
      }
      case "ONBOARD_ORG":
        if (!org.trim()) throw new Error("Org is required.");
        if (memberIds.length === 0) throw new Error("Select at least one starting member.");
        return { org: org.trim(), members: memberIds, k: k ? Number(k) : undefined };
      case "CHANGE_ABAC_POLICY": {
        let policy;
        try {
          policy = JSON.parse(policyText);
        } catch {
          throw new Error("Policy must be valid JSON.");
        }
        return { policy };
      }
      case "POOL_REINSTATEMENT":
        if (!["ORG_ADMIN", "SECURITY_ADMIN"].includes(poolType)) {
          throw new Error("Pool type must be ORG_ADMIN or SECURITY_ADMIN.");
        }
        if (poolType === "ORG_ADMIN" && !org.trim()) throw new Error("Org is required for an ORG_ADMIN pool.");
        if (memberIds.length === 0) throw new Error("Select at least one member.");
        return {
          poolType,
          org: poolType === "ORG_ADMIN" ? org.trim() : undefined,
          members: memberIds,
          k: k ? Number(k) : undefined,
        };
      default:
        return {};
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError("");
    let payload;
    try {
      payload = buildPayload();
    } catch (err) {
      setError(err.message);
      return;
    }
    setBusy(true);
    try {
      const res = await api.post("/governance/proposals", { actionType, payload });
      onCreated(res.data);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not file proposal."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-900">File governance proposal</h2>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <Select
            label="Action"
            value={actionType}
            onChange={(e) => {
              setActionType(e.target.value);
              setError("");
            }}
          >
            {SUDO_ACTION_TYPES.map((a) => (
              <option key={a} value={a}>
                {titleCase(a)}
              </option>
            ))}
          </Select>
          <p className="-mt-2 text-xs text-slate-500">{ACTION_HELP[actionType]}</p>

          {(actionType === "APPOINT_ORG_ADMIN" || actionType === "REMOVE_ORG_ADMIN") && (
            <>
              <OrgPicker required value={org} onChange={(v) => setOrg(v)} />
              <UserPicker label="User" value={userId} onChange={(id) => setUserId(id)} />
            </>
          )}

          {(actionType === "APPOINT_SYSTEM_ADMIN" || actionType === "REMOVE_SYSTEM_ADMIN") && (
            <UserPicker label="User" value={userId} onChange={(id) => setUserId(id)} />
          )}

          {actionType === "CHANGE_POOL_THRESHOLD" && (
            <>
              <Select label="Pool type" value={poolType} onChange={(e) => setPoolType(e.target.value)}>
                {POOL_TYPES.map((p) => (
                  <option key={p} value={p}>
                    {titleCase(p)}
                  </option>
                ))}
              </Select>
              {poolType === "ORG_ADMIN" && (
                <OrgPicker required value={org} onChange={(v) => setOrg(v)} />
              )}
              <Input
                label="New k (votes required)"
                type="number"
                min={2}
                required
                value={k}
                onChange={(e) => setK(e.target.value)}
              />
            </>
          )}

          {actionType === "ONBOARD_ORG" && (
            <>
              <OrgPicker label="Org (must already exist in Reference Data)" required value={org} onChange={(v) => setOrg(v)} />
              <UserPicker
                label="Starting members"
                multi
                value={memberIds}
                onChange={(ids) => setMemberIds(ids)}
              />
              <Input
                label="k (optional — defaults to floor(m/2)+1)"
                type="number"
                min={2}
                value={k}
                onChange={(e) => setK(e.target.value)}
              />
            </>
          )}

          {actionType === "POOL_REINSTATEMENT" && (
            <>
              <Select label="Pool type" value={poolType} onChange={(e) => setPoolType(e.target.value)}>
                <option value="ORG_ADMIN">Org Admin</option>
                <option value="SECURITY_ADMIN">Security Admin</option>
              </Select>
              {poolType === "ORG_ADMIN" && (
                <OrgPicker required value={org} onChange={(v) => setOrg(v)} />
              )}
              <UserPicker
                label="Reconstituted roster"
                multi
                value={memberIds}
                onChange={(ids) => setMemberIds(ids)}
              />
              <Input
                label="k (optional — defaults to floor(m/2)+1)"
                type="number"
                min={2}
                value={k}
                onChange={(e) => setK(e.target.value)}
              />
            </>
          )}

          {actionType === "CHANGE_ABAC_POLICY" && (
            <div>
              <span className="mb-1 block text-sm font-medium text-slate-700">
                Policy override (JSON)
              </span>
              <p className="mb-1 text-xs text-slate-500">
                Allowed top-level keys: {ABAC_POLICY_KEYS.join(", ")}. Object-valued keys merge onto the
                current policy; only the keys you include are changed.
              </p>
              <textarea
                rows={8}
                spellCheck={false}
                className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-blue-600"
                value={policyText}
                onChange={(e) => setPolicyText(e.target.value)}
              />
            </div>
          )}

          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Filing…" : "File proposal"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
