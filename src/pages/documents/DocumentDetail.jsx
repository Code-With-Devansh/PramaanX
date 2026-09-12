import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { useStepUp } from "../../lib/StepUpContext";
import { formatBytes, formatDate, titleCase } from "../../lib/format";
import {
  Badge,
  Button,
  Card,
  ClassificationBadge,
  ErrorText,
  IntegrityBadge,
  PageHeader,
  Spinner,
  apiErrorMessage,
} from "../../components/ui";
import { Can } from "../../components/guards";
import AddVersionDialog from "./AddVersionDialog";
import CommentsThread from "../../components/CommentsThread";
import UserPicker from "../../components/UserPicker";

const TABS = ["Versions", "Integrity", "Custody", "Access", "Comments"];

export default function DocumentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { requestStepUp } = useStepUp();

  const [doc, setDoc] = useState(null);
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("Versions");
  const [showAddVersion, setShowAddVersion] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [docRes, versionsRes] = await Promise.all([
        api.get(`/documents/${id}`),
        api.get(`/documents/${id}/versions`),
      ]);
      setDoc(docRes.data);
      setVersions(versionsRes.data.items);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not load this document."));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSeal() {
    const reason = window.prompt("Reason for sealing this document (optional):") || undefined;
    try {
      const stepUpToken = await requestStepUp("seal this document");
      const res = await api.post(
        `/documents/${id}/seal`,
        { reason },
        { headers: { "X-Step-Up-Token": stepUpToken } }
      );
      setDoc(res.data);
    } catch (err) {
      if (err.message !== "step-up cancelled") {
        setError(apiErrorMessage(err, "Could not seal document."));
      }
    }
  }

  async function handleDownload(versionId) {
    try {
      const res = await api.get(`/documents/${id}/versions/${versionId}/download`);
      window.open(res.data.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(apiErrorMessage(err, "Could not generate a download link."));
    }
  }

  async function handleRestore(versionId) {
    if (!window.confirm("Restore this version as the current version?")) return;
    try {
      const res = await api.post(`/documents/${id}/versions/${versionId}/restore`);
      setDoc(res.data);
      load();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not restore version."));
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (error && !doc) return <ErrorText>{error}</ErrorText>;
  if (!doc) return null;

  return (
    <div>
      <button
        onClick={() => navigate(`/cases/${doc.caseId}`)}
        className="mb-4 text-sm text-slate-500 hover:text-slate-700"
      >
        ← Back to case
      </button>

      <PageHeader
        title={doc.title}
        subtitle={`${titleCase(doc.docType)} · v${doc.currentVersionNo ?? "—"} of ${doc.versionsCount}`}
        actions={
          <>
            <Can permission="document:add-version">
              {!doc.sealed && <Button variant="secondary" onClick={() => setShowAddVersion(true)}>Add version</Button>}
            </Can>
            <Can permission="document:seal">
              {!doc.sealed && (
                <Button variant="danger" onClick={handleSeal}>
                  Seal document
                </Button>
              )}
            </Can>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ClassificationBadge value={doc.classification} />
        <IntegrityBadge value={doc.integrityStatus} />
        <Badge className="border-slate-300 bg-slate-100 text-slate-700">
          Ledger: {titleCase(doc.ledgerStatus)}
        </Badge>
        {doc.sealed && (
          <Badge className="border-slate-400 bg-slate-800 text-white">🔒 Sealed</Badge>
        )}
      </div>

      <ErrorText>{error}</ErrorText>

      {!hasPermission("document:add-version") && !hasPermission("document:seal") && (
        <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">
          {hasPermission("document:sign")
            ? "✍ Your role can sign filings, but signing isn't available in this system yet — you can read and verify this document."
            : "👁 View-only access — your role can read this document but not modify it."}
        </div>
      )}

      {doc.description && (
        <Card className="mb-4 p-4 text-sm text-slate-600">{doc.description}</Card>
      )}

      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium ${
              tab === t
                ? "border-b-2 border-blue-700 text-blue-700"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Versions" && (
        <VersionsTab
          versions={versions}
          currentVersionId={doc.currentVersionId}
          sealed={doc.sealed}
          onDownload={handleDownload}
          onRestore={handleRestore}
        />
      )}
      {tab === "Integrity" && <IntegrityTab documentId={id} />}
      {tab === "Custody" && <CustodyTab documentId={id} />}
      {tab === "Access" && <AccessTab documentId={id} />}
      {tab === "Comments" && (
        <Card className="p-5">
          <CommentsThread documentId={id} />
        </Card>
      )}

      {showAddVersion && (
        <AddVersionDialog
          documentId={id}
          onClose={() => setShowAddVersion(false)}
          onAdded={() => {
            setShowAddVersion(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function VersionsTab({ versions, currentVersionId, sealed, onDownload, onRestore }) {
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3">Version</th>
            <th className="px-4 py-3">File</th>
            <th className="px-4 py-3">Size</th>
            <th className="px-4 py-3">Ledger</th>
            <th className="px-4 py-3">Uploaded</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {versions.map((v) => (
            <tr key={v.id} className={v.id === currentVersionId ? "bg-blue-50/40" : ""}>
              <td className="px-4 py-3 font-medium text-slate-900">
                v{v.versionNo} {v.id === currentVersionId && <Badge className="ml-1 border-blue-300 bg-blue-50 text-blue-700">Current</Badge>}
              </td>
              <td className="px-4 py-3 text-slate-700">
                {v.fileName}
                {v.note && <p className="text-xs text-slate-400">{v.note}</p>}
              </td>
              <td className="px-4 py-3 text-slate-600">{formatBytes(v.sizeBytes)}</td>
              <td className="px-4 py-3">
                <Badge className="border-slate-300 bg-slate-100 text-slate-700">
                  {titleCase(v.ledgerStatus)}
                </Badge>
              </td>
              <td className="px-4 py-3 text-slate-500">{formatDate(v.createdAt)}</td>
              <td className="px-4 py-3 text-right">
                <button
                  onClick={() => onDownload(v.id)}
                  className="mr-3 text-xs font-medium text-blue-700 hover:underline"
                >
                  Download
                </button>
                {v.id !== currentVersionId && !sealed && (
                  <button
                    onClick={() => onRestore(v.id)}
                    className="text-xs font-medium text-slate-600 hover:underline"
                  >
                    Restore
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function IntegrityTab({ documentId }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    try {
      const res = await api.get(`/documents/${documentId}/integrity`);
      setResult(res.data);
    } catch (err) {
      setError(apiErrorMessage(err, "Integrity check failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Integrity verification</h2>
        <Button variant="secondary" onClick={run} disabled={busy}>
          {busy ? "Checking…" : "Run check"}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {result && (
        <dl className="space-y-2 text-sm">
          <Row label="Status">
            <IntegrityBadge value={result.status} />
          </Row>
          <Row label="Matches recorded hash">{result.matches ? "Yes" : "No"}</Row>
          <Row label="Current SHA-256">
            <code className="break-all text-xs">{result.sha256}</code>
          </Row>
          <Row label="Ledger hash">
            <code className="break-all text-xs">{result.ledgerHash ?? "—"}</code>
          </Row>
          <Row label="Ledger transaction">
            <code className="break-all text-xs">{result.ledgerTxId ?? "—"}</code>
          </Row>
          <Row label="Checked at">{formatDate(result.lastCheckedAt)}</Row>
        </dl>
      )}
    </Card>
  );
}

function CustodyTab({ documentId }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get(`/documents/${documentId}/custody`);
        setEvents(res.data.events);
      } catch (err) {
        setError(apiErrorMessage(err, "Could not load chain of custody."));
      }
    })();
  }, [documentId]);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!events) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  return (
    <Card className="p-5">
      <h2 className="mb-4 text-sm font-semibold text-slate-900">Chain of custody</h2>
      {events.length === 0 ? (
        <p className="text-sm text-slate-500">No ledger events yet.</p>
      ) : (
        <ol className="space-y-4 border-l border-slate-200 pl-4">
          {events.map((e, i) => (
            <li key={i} className="relative">
              <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-blue-600" />
              <p className="text-sm font-medium text-slate-900">
                {titleCase(e.action)} <span className="font-normal text-slate-400">· v{e.versionNo}</span>
              </p>
              <p className="text-xs text-slate-500">
                {formatDate(e.timestamp)} {e.actor && <>· actor {e.actor}</>}
              </p>
              {(e.ledgerTxId || e.hash) && (
                <p className="mt-1 space-x-2 font-mono text-[11px] text-slate-400">
                  {e.ledgerTxId && <span>tx {e.ledgerTxId}</span>}
                  {e.hash && <span className="break-all">sha256 {e.hash}</span>}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function AccessTab({ documentId }) {
  const [grants, setGrants] = useState(null);
  const [error, setError] = useState("");
  const [granteeUserId, setGranteeUserId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get(`/documents/${documentId}/access`);
      setGrants(res.data);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not load access grants."));
    }
  }, [documentId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleGrant(e) {
    e.preventDefault();
    if (!granteeUserId || !expiresAt) {
      setError("Choose a user and an expiry date.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.post(`/documents/${documentId}/access`, {
        granteeUserId,
        expiresAt: new Date(expiresAt).toISOString(),
      });
      setGranteeUserId("");
      setExpiresAt("");
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not grant access."));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(userId) {
    if (!window.confirm("Revoke this user's access to the document?")) return;
    setError("");
    try {
      await api.delete(`/documents/${documentId}/access/${userId}`);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not revoke access."));
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Explicit access grants</h2>
      <p className="mb-4 text-xs text-slate-500">
        Read-only, time-bound access for a specific user — in addition to whatever access their
        role and case assignment already give them.
      </p>
      <ErrorText>{error}</ErrorText>

      <Can permission="document:share">
        <form onSubmit={handleGrant} className="mb-5 flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <UserPicker label="Grant to" value={granteeUserId} onChange={(id) => setGranteeUserId(id)} />
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Expires</span>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-600"
            />
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? "Granting…" : "Grant access"}
          </Button>
        </form>
      </Can>

      {!grants ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : grants.length === 0 ? (
        <p className="text-sm text-slate-500">No explicit access grants on this document.</p>
      ) : (
        <ul className="space-y-2">
          {grants.map((g) => (
            <li key={g.id} className="flex items-center justify-between rounded-md border border-slate-100 p-3 text-sm">
              <div>
                <p className="font-mono text-xs text-slate-600">{g.grantee?.id}</p>
                <p className="text-xs text-slate-400">
                  Expires {formatDate(g.expiresAt)}
                  {g.crossJurisdiction && " · cross-jurisdiction"}
                </p>
              </div>
              <Can permission="document:share">
                <button
                  onClick={() => handleRevoke(g.grantee?.id)}
                  className="text-xs font-medium text-red-600 hover:underline"
                >
                  Revoke
                </button>
              </Can>
            </li>
          ))}
        </ul>
      )}
    </Card>
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
