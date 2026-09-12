import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import {
  PROPOSAL_STATUSES,
  PROPOSAL_STATUS_STYLES,
  SUDO_ACTION_TYPES,
  formatDate,
  titleCase,
} from "../../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  PageHeader,
  Select,
  Spinner,
  apiErrorMessage,
} from "../../components/ui";
import { Can } from "../../components/guards";
import NewProposalDialog from "./NewProposalDialog";
import { useReference } from "../../lib/ReferenceContext";
import { OrgPicker } from "../../components/ReferencePicker";

export default function ProposalsList() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [actionType, setActionType] = useState("");
  const [org, setOrg] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showNew, setShowNew] = useState(false);
  const { orgName } = useReference();
  const pageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/governance/proposals", {
        params: {
          page,
          pageSize,
          status: status || undefined,
          actionType: actionType || undefined,
          org: org || undefined,
        },
      });
      setItems(res.data.items);
      setTotal(res.data.total);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not load proposals."));
    } finally {
      setLoading(false);
    }
  }, [page, status, actionType, org]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <PageHeader
        title="Governance"
        subtitle="Admin-tier changes require k-of-m quorum approval — nothing here is unilateral."
        actions={
          <Can permission="governance:propose">
            <Button onClick={() => setShowNew(true)}>File proposal</Button>
          </Can>
        }
      />

      <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
        Bootstrapping the very first admin and Tier-3 recovery (regenesis) are
        deliberately not available here — they require an out-of-band secret and
        run through the genesis CLI, not the web app.
      </div>

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-48">
            <Select
              label="Status"
              value={status}
              onChange={(e) => {
                setPage(1);
                setStatus(e.target.value);
              }}
            >
              <option value="">All statuses</option>
              {PROPOSAL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-56">
            <Select
              label="Action"
              value={actionType}
              onChange={(e) => {
                setPage(1);
                setActionType(e.target.value);
              }}
            >
              <option value="">All actions</option>
              {SUDO_ACTION_TYPES.map((a) => (
                <option key={a} value={a}>
                  {titleCase(a)}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-[200px] flex-1">
            <OrgPicker
              label="Org"
              value={org}
              onChange={(v) => {
                setPage(1);
                setOrg(v);
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
        <EmptyState title="No proposals found" subtitle="Try adjusting your filters." />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Org</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Filed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-900">
                    <Link to={`/governance/${p.id}`} className="text-blue-700 hover:underline">
                      {titleCase(p.actionType)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{p.org ? orgName(p.org) : "—"}</td>
                  <td className="px-4 py-3">
                    <Badge
                      className={
                        PROPOSAL_STATUS_STYLES[p.status] || "border-slate-300 bg-slate-100 text-slate-700"
                      }
                    >
                      {titleCase(p.status)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
          <span>
            Page {page} of {totalPages} · {total} proposals
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

      {showNew && (
        <NewProposalDialog
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            load();
          }}
        />
      )}
    </div>
  );
}
