import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { useStepUp } from "../../lib/StepUpContext";
import { PROPOSAL_STATUS_STYLES, formatDate, titleCase } from "../../lib/format";
import {
  Badge,
  Button,
  Card,
  ErrorText,
  PageHeader,
  Spinner,
  apiErrorMessage,
} from "../../components/ui";
import { Can } from "../../components/guards";
import { useReference } from "../../lib/ReferenceContext";

export default function ProposalDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { requestStepUp } = useStepUp();
  const { orgName } = useReference();

  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyAction, setBusyAction] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get(`/governance/proposals/${id}`);
      setProposal(res.data);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not load this proposal."));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const myVote = proposal?.approvals?.find((a) => a.approverId === user?.id);
  const myObjection = proposal?.objections?.find((o) => o.objectorId === user?.id);
  const isPending = proposal?.status === "PENDING";

  async function handleApprove() {
    setActionError("");
    setBusyAction("approve");
    try {
      const stepUpToken = await requestStepUp("approve this governance proposal");
      await api.post(
        `/governance/proposals/${id}/approve`,
        {},
        { headers: { "X-Step-Up-Token": stepUpToken } }
      );
      await load();
    } catch (err) {
      if (err.message !== "step-up cancelled") {
        setActionError(apiErrorMessage(err, "Could not approve this proposal."));
      }
    } finally {
      setBusyAction("");
    }
  }

  async function handleObject() {
    const reason = window.prompt("Reason for objecting (optional):") || undefined;
    setActionError("");
    setBusyAction("object");
    try {
      await api.post(`/governance/proposals/${id}/object`, { reason });
      await load();
    } catch (err) {
      setActionError(apiErrorMessage(err, "Could not object to this proposal."));
    } finally {
      setBusyAction("");
    }
  }

  async function handleExecute() {
    if (!window.confirm("Execute this proposal now? This applies the change immediately.")) return;
    setActionError("");
    setBusyAction("execute");
    try {
      const stepUpToken = await requestStepUp("execute this governance proposal");
      await api.post(
        `/governance/proposals/${id}/execute`,
        {},
        { headers: { "X-Step-Up-Token": stepUpToken } }
      );
      await load();
    } catch (err) {
      if (err.message !== "step-up cancelled") {
        setActionError(apiErrorMessage(err, "Could not execute this proposal."));
      }
    } finally {
      setBusyAction("");
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (error && !proposal) return <ErrorText>{error}</ErrorText>;
  if (!proposal) return null;

  return (
    <div>
      <button onClick={() => navigate("/governance")} className="mb-4 text-sm text-slate-500 hover:text-slate-700">
        ← Back to proposals
      </button>

      <PageHeader
        title={titleCase(proposal.actionType)}
        subtitle={proposal.org ? `Org: ${orgName(proposal.org)}` : "System-wide"}
        actions={
          <Badge
            className={PROPOSAL_STATUS_STYLES[proposal.status] || "border-slate-300 bg-slate-100 text-slate-700"}
          >
            {titleCase(proposal.status)}
          </Badge>
        }
      />

      <ErrorText>{error || actionError}</ErrorText>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Payload</h2>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-slate-50 p-3 text-xs text-slate-700">
              {JSON.stringify(proposal.payload, null, 2)}
            </pre>
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">
              Approvals ({proposal.approvals.length})
            </h2>
            {proposal.approvals.length === 0 ? (
              <p className="text-sm text-slate-500">No approvals yet.</p>
            ) : (
              <ul className="space-y-2">
                {proposal.approvals.map((a) => (
                  <li key={a.id} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-xs text-slate-600">{a.approverId}</span>
                    <span className="flex items-center gap-2">
                      <Badge className="border-slate-300 bg-slate-100 text-slate-700">
                        {titleCase(a.approverPoolRole)}
                      </Badge>
                      <span className="text-xs text-slate-400">{formatDate(a.createdAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">
              Objections ({proposal.objections.length})
            </h2>
            {proposal.objections.length === 0 ? (
              <p className="text-sm text-slate-500">No objections.</p>
            ) : (
              <ul className="space-y-3">
                {proposal.objections.map((o) => (
                  <li key={o.id} className="rounded-md border border-red-100 bg-red-50 p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-slate-600">{o.objectorId}</span>
                      <span className="text-xs text-slate-400">{formatDate(o.createdAt)}</span>
                    </div>
                    {o.reason && <p className="mt-1 text-slate-700">{o.reason}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Details</h2>
            <dl className="space-y-2 text-sm">
              <Row label="Proposed by">
                <span className="font-mono text-xs">{proposal.proposedBy}</span>
              </Row>
              <Row label="Filed">{formatDate(proposal.createdAt)}</Row>
              {proposal.executesAfter && <Row label="Executable after">{formatDate(proposal.executesAfter)}</Row>}
              {proposal.executedAt && <Row label="Executed">{formatDate(proposal.executedAt)}</Row>}
            </dl>
          </Card>

          {isPending && (
            <Can permission="governance:approve">
              <Card className="p-5">
                <h2 className="mb-2 text-sm font-semibold text-slate-900">Cast your vote</h2>
                <p className="mb-3 text-xs text-slate-500">
                  Eligibility (pool membership, cross-tier co-sign, or auditor quorum) is verified
                  by the server — this panel shows the actions available to your role, not a
                  guarantee you're eligible for this specific proposal.
                </p>
                {myVote ? (
                  <p className="text-sm text-emerald-700">
                    ✓ You approved this as {titleCase(myVote.approverPoolRole)}.
                  </p>
                ) : myObjection ? (
                  <p className="text-sm text-red-700">You objected to this proposal.</p>
                ) : (
                  <div className="flex gap-2">
                    <Button onClick={handleApprove} disabled={!!busyAction} className="flex-1">
                      {busyAction === "approve" ? "Approving…" : "Approve"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={handleObject}
                      disabled={!!busyAction}
                      className="flex-1"
                    >
                      {busyAction === "object" ? "Objecting…" : "Object"}
                    </Button>
                  </div>
                )}
              </Card>

              <Card className="p-5">
                <h2 className="mb-2 text-sm font-semibold text-slate-900">Execute</h2>
                <p className="mb-3 text-xs text-slate-500">
                  Re-checks quorum from the actual approval records at the moment you execute —
                  it will fail if quorum isn't met yet.
                </p>
                <Button variant="danger" onClick={handleExecute} disabled={!!busyAction} className="w-full">
                  {busyAction === "execute" ? "Executing…" : "Execute proposal"}
                </Button>
              </Card>
            </Can>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="text-right text-slate-900">{children}</dd>
    </div>
  );
}
