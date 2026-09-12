import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatDate, titleCase } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Input,
  PageHeader,
  Select,
  Spinner,
  apiErrorMessage,
} from "../components/ui";

const ACTIONS = [
  "DOCUMENT_CREATED",
  "VERSION_ADDED",
  "VERSION_RESTORED",
  "VERSION_DOWNLOADED",
  "VERSION_ANCHORED",
  "VERSION_ANCHOR_FAILED",
  "VERSION_VERIFIED",
  "DOCUMENT_SEALED",
  "DOCUMENT_DELETED",
  "USER_PROVISIONED",
  "USER_UPDATED",
  "USER_DEACTIVATED",
  "USER_MFA_RESET",
];
const TARGET_TYPES = ["DOCUMENT", "VERSION", "CASE", "USER", "GOVERNANCE_PROPOSAL", "ADMIN_POOL", "ABAC_POLICY"];

export default function Audit() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const [targetType, setTargetType] = useState("");
  const [targetId, setTargetId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const pageSize = 25;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/audit", {
        params: {
          page,
          pageSize,
          action: action || undefined,
          targetType: targetType || undefined,
          targetId: targetId || undefined,
        },
      });
      setItems(res.data.items);
      setTotal(res.data.total);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not load the audit log."));
    } finally {
      setLoading(false);
    }
  }, [page, action, targetType, targetId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleVerify() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await api.get("/audit/verify");
      setVerifyResult(res.data);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not verify the audit chain."));
    } finally {
      setVerifying(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <PageHeader
        title="Audit Log"
        subtitle="Tamper-evident record of every sensitive action in the system."
        actions={
          <Button variant="secondary" onClick={handleVerify} disabled={verifying}>
            {verifying ? "Verifying…" : "Verify chain integrity"}
          </Button>
        }
      />

      {verifyResult && (
        <div
          className={`mb-4 rounded-md border px-4 py-2 text-sm ${
            verifyResult.valid
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {verifyResult.valid
            ? "✓ Audit chain is intact — no tampering detected."
            : `⚠ Audit chain integrity check failed${verifyResult.brokenAtSeq ? ` at entry #${verifyResult.brokenAtSeq}` : ""}${verifyResult.reason ? ` (${verifyResult.reason})` : ""}.`}
        </div>
      )}

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Select
              label="Action"
              value={action}
              onChange={(e) => {
                setPage(1);
                setAction(e.target.value);
              }}
            >
              <option value="">All actions</option>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {titleCase(a)}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-48">
            <Select
              label="Target type"
              value={targetType}
              onChange={(e) => {
                setPage(1);
                setTargetType(e.target.value);
              }}
            >
              <option value="">All targets</option>
              {TARGET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-[220px] flex-1">
            <Input
              label="Target ID"
              placeholder="UUID"
              value={targetId}
              onChange={(e) => {
                setPage(1);
                setTargetId(e.target.value);
              }}
            />
          </div>
        </div>
      </Card>

      <ErrorText>{error}</ErrorText>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="No audit entries found" subtitle="Try adjusting your filters." />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Timestamp</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Target</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((entry) => (
                <tr key={entry.id} className="align-top hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{formatDate(entry.timestamp)}</td>
                  <td className="px-4 py-3">
                    <Badge className="border-slate-300 bg-slate-100 text-slate-700">
                      {titleCase(entry.action)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {titleCase(entry.targetType)}
                    {entry.targetId && (
                      <p className="font-mono text-xs text-slate-400">{entry.targetId}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{entry.actor?.id ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{entry.ip || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
          <span>
            Page {page} of {totalPages} · {total} entries
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
