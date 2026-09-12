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
    <div className="w-full min-w-0">
      <PageHeader
        title="Governance"
        subtitle="Admin-tier changes require k-of-m quorum approval — nothing here is unilateral."
        actions={
          <Can permission="governance:propose">
            <Button
              onClick={() => setShowNew(true)}
              className="w-full sm:w-auto"
            >
              File proposal
            </Button>
          </Can>
        }
      />

      <div className="mb-4 wrap-break-words rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
        Bootstrapping the very first admin and Tier-3 recovery (regenesis) are
        deliberately not available here — they require an out-of-band secret
        and run through the genesis CLI, not the web app.
      </div>

      <Card className="mb-4 p-4">
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="w-full sm:w-48">
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

          <div className="w-full sm:w-56">
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

          <div className="w-full min-w-0 flex-1 sm:min-w-200px">
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
        <EmptyState
          title="No proposals found"
          subtitle="Try adjusting your filters."
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-650px text-left text-sm">
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
                  <tr
                    key={p.id}
                    className="hover:bg-slate-50"
                  >
                    <td className="px-4 py-3 font-medium text-slate-900">
                      <Link
                        to={`/governance/${p.id}`}
                        className="wrap-break-words text-blue-700 hover:underline"
                      >
                        {titleCase(p.actionType)}
                      </Link>
                    </td>

                    <td className="px-4 py-3 text-slate-600">
                      <span className="wrap-break-words">
                        {p.org ? orgName(p.org) : "—"}
                      </span>
                    </td>

                    <td className="px-4 py-3">
                      <Badge
                        className={
                          PROPOSAL_STATUS_STYLES[p.status] ||
                          "border-slate-300 bg-slate-100 text-slate-700"
                        }
                      >
                        {titleCase(p.status)}
                      </Badge>
                    </td>

                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">
                      {formatDate(p.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex flex-col gap-3 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
          <span>
            Page {page} of {totalPages} · {total} proposals
          </span>

          <div className="flex w-full gap-2 sm:w-auto">
            <Button
              variant="secondary"
              className="flex-1 sm:flex-none"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>

            <Button
              variant="secondary"
              className="flex-1 sm:flex-none"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
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