import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { useStepUp } from "../../lib/StepUpContext";
import { CASE_STATUSES, formatDate, titleCase } from "../../lib/format";
import {
  Badge,
  Button,
  Card,
  ClassificationBadge,
  EmptyState,
  ErrorText,
  IntegrityBadge,
  PageHeader,
  Select,
  Spinner,
  apiErrorMessage,
} from "../../components/ui";
import { Can } from "../../components/guards";
import UploadDocumentDialog from "../documents/UploadDocumentDialog";
import AssignOfficerDialog from "./AssignOfficerDialog";
import { useReference } from "../../lib/ReferenceContext";
import CommentsThread from "../../components/CommentsThread";

export default function CaseDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { requestStepUp } = useStepUp();
  const { jurisdictionName } = useReference();

  const [caseData, setCaseData] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [holdBusy, setHoldBusy] = useState(false);
  const [holdError, setHoldError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [caseRes, docsRes] = await Promise.all([
        api.get(`/cases/${id}`),
        api.get(`/cases/${id}/documents`, { params: { page: 1, pageSize: 50 } }),
      ]);
      setCaseData(caseRes.data);
      setDocuments(docsRes.data.items);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not load this case."));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleStatusChange(status) {
    try {
      const res = await api.patch(`/cases/${id}`, { status });
      setCaseData(res.data);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not update case status."));
    }
  }

  // NOTE: the backend wires these verbs the other way around — DELETE places the
  // hold (requires a reason) and POST releases it. We follow the backend as-is.
  async function placeLegalHold() {
    const reason = window.prompt("Reason for legal hold:");
    if (!reason) return;
    setHoldBusy(true);
    setHoldError("");
    try {
      const stepUpToken = await requestStepUp("place a legal hold on this case");
      const res = await api.delete(`/cases/${id}/legal-hold`, {
        data: { reason },
        __stepUp: true,
        headers: { "X-Step-Up-Token": stepUpToken },
      });
      setCaseData(res.data);
    } catch (err) {
      if (err.message !== "step-up cancelled") {
        setHoldError(apiErrorMessage(err, "Could not place legal hold."));
      }
    } finally {
      setHoldBusy(false);
    }
  }

  async function releaseLegalHold() {
    if (!window.confirm("Release the legal hold on this case?")) return;
    setHoldBusy(true);
    setHoldError("");
    try {
      const stepUpToken = await requestStepUp("release the legal hold on this case");
      const res = await api.post(
        `/cases/${id}/legal-hold`,
        {},
        { __stepUp: true, headers: { "X-Step-Up-Token": stepUpToken } }
      );
      setCaseData(res.data);
    } catch (err) {
      if (err.message !== "step-up cancelled") {
        setHoldError(apiErrorMessage(err, "Could not release legal hold."));
      }
    } finally {
      setHoldBusy(false);
    }
  }

  async function handleRemoveOfficer(userId) {
    if (!window.confirm("Remove this officer from the case?")) return;
    try {
      const res = await api.delete(`/cases/${id}/officers/${userId}`);
      setCaseData(res.data);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not remove officer."));
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (error && !caseData) {
    return <ErrorText>{error}</ErrorText>;
  }

  if (!caseData) return null;

  return (
    <div>
      <button
        onClick={() => navigate("/")}
        className="mb-4 text-sm text-slate-500 hover:text-slate-700"
      >
        ← Back to cases
      </button>

      <PageHeader
        title={caseData.title}
        subtitle={`${caseData.caseNumber} · ${caseData.type} · ${jurisdictionName(caseData.jurisdictionId)}`}
        actions={
          <Can permission="document:create">
            <Button onClick={() => setShowUpload(true)}>Upload document</Button>
          </Can>
        }
      />

      {!hasPermission("case:update") && !hasPermission("document:create") && (
        <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">
          👁 View-only access — your role can read this case but not edit it or add documents.
        </div>
      )}

      {caseData.legalHold && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-800">
          ⚠ This case is under legal hold.
        </div>
      )}

      <ErrorText>{error}</ErrorText>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Documents</h2>
            {documents.length === 0 ? (
              <EmptyState title="No documents yet" subtitle="Upload the first document for this case." />
            ) : (
              <div className="divide-y divide-slate-100">
                {documents.map((doc) => (
                  <Link
                    key={doc.id}
                    to={`/documents/${doc.id}`}
                    className="flex items-center justify-between py-3 hover:bg-slate-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">{doc.title}</p>
                      <p className="text-xs text-slate-500">
                        {titleCase(doc.docType)} · v{doc.currentVersionNo ?? "—"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <ClassificationBadge value={doc.classification} />
                      <IntegrityBadge value={doc.integrityStatus} />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Comments</h2>
            <CommentsThread caseId={id} />
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Case details</h2>
            <dl className="space-y-2 text-sm">
              <Row label="Status">
                <Can permission="case:update" fallback={<Badge className="border-slate-300 bg-slate-100 text-slate-700">{titleCase(caseData.status)}</Badge>}>
                  <Select
                    value={caseData.status}
                    onChange={(e) => handleStatusChange(e.target.value)}
                    className="py-1! text-xs"
                  >
                    {CASE_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {titleCase(s)}
                      </option>
                    ))}
                  </Select>
                </Can>
              </Row>
              <Row label="Classification">
                <ClassificationBadge value={caseData.classification} />
              </Row>
              <Row label="Documents">{caseData.documentCount}</Row>
              <Row label="Created">{formatDate(caseData.createdAt)}</Row>
              <Row label="Updated">{formatDate(caseData.updatedAt)}</Row>
            </dl>
            {caseData.description && (
              <p className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-600">
                {caseData.description}
              </p>
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Assigned officers</h2>
              <Can permission="case:manage">
                <button
                  onClick={() => setShowAssign(true)}
                  className="text-xs font-medium text-blue-700 hover:underline"
                >
                  + Assign
                </button>
              </Can>
            </div>
            {caseData.assignedOfficers.length === 0 ? (
              <p className="text-sm text-slate-500">No officers assigned.</p>
            ) : (
              <ul className="space-y-2">
                {caseData.assignedOfficers.map((o) => (
                  <li key={o.id} className="flex items-center justify-between text-sm">
                    <span className="text-slate-700">
                      {o.id} <span className="text-xs text-slate-400">· {titleCase(o.roleOnCase)}</span>
                    </span>
                    <Can permission="case:manage">
                      <button
                        onClick={() => handleRemoveOfficer(o.id)}
                        className="text-xs text-red-600 hover:underline"
                      >
                        Remove
                      </button>
                    </Can>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Can permission="case:legal-hold">
            <Card className="p-5">
              <h2 className="mb-2 text-sm font-semibold text-slate-900">Legal hold</h2>
              <p className="mb-3 text-sm text-slate-500">
                Placing a hold blocks case changes tied to preservation obligations.
              </p>
              <ErrorText>{holdError}</ErrorText>
              {caseData.legalHold ? (
                <Button variant="secondary" disabled={holdBusy} onClick={releaseLegalHold} className="w-full">
                  Release legal hold
                </Button>
              ) : (
                <Button variant="danger" disabled={holdBusy} onClick={placeLegalHold} className="w-full">
                  Place legal hold
                </Button>
              )}
            </Card>
          </Can>
        </div>
      </div>

      {showUpload && (
        <UploadDocumentDialog
          caseId={id}
          onClose={() => setShowUpload(false)}
          onUploaded={() => {
            setShowUpload(false);
            load();
          }}
        />
      )}

      {showAssign && (
        <AssignOfficerDialog
          caseId={id}
          onClose={() => setShowAssign(false)}
          onAssigned={() => {
            setShowAssign(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-slate-900">{children}</dd>
    </div>
  );
}
