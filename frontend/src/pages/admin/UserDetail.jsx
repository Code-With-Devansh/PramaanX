import { useCallback, useEffect, useState } from "react";

import { useNavigate, useParams } from "react-router-dom";

import { api } from "../../lib/api";

import { useStepUp } from "../../lib/StepUpContext";

import {
  CLASSIFICATIONS,
  ROLES,
  formatDate,
  titleCase,
} from "../../lib/format";

import {
  Badge,
  Button,
  Card,
  ErrorText,
  PageHeader,
  Select,
  Spinner,
  apiErrorMessage,
} from "../../components/ui";

import { Can } from "../../components/guards";

import { useReference } from "../../lib/ReferenceContext";

import { JurisdictionPicker } from "../../components/ReferencePicker";

const ADMIN_TIER_ROLES = new Set([
  "SYSTEM_ADMIN",
  "SECURITY_ADMIN",
  "ORG_ADMIN",
]);

const EDITABLE_ROLES = ROLES.filter(
  (r) => !ADMIN_TIER_ROLES.has(r)
);

const STATUSES = ["ACTIVE", "DISABLED"];

export default function UserDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { requestStepUp } = useStepUp();
  const { orgName, jurisdictionName } = useReference();

  const [user, setUser] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [userRes, sessionsRes] = await Promise.all([
        api.get(`/users/${id}`),
        api.get(`/users/${id}/sessions`),
      ]);

      setUser(userRes.data);
      setSessions(sessionsRes.data.items);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not load this user."));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function updateField(field, value) {
    setError("");

    try {
      const stepUpToken = await requestStepUp(
        "update this user's profile"
      );

      const res = await api.patch(
        `/users/${id}`,
        { [field]: value },
        { headers: { "X-Step-Up-Token": stepUpToken } }
      );

      setUser(res.data);
    } catch (err) {
      if (err.message !== "step-up cancelled") {
        setError(apiErrorMessage(err, "Could not update user."));
      }
    }
  }

  async function handleDeactivate() {
    if (
      !window.confirm(
        `Deactivate ${user.fullName}? They will lose access immediately.`
      )
    ) {
      return;
    }

    setError("");

    try {
      const stepUpToken = await requestStepUp(
        "deactivate this user"
      );

      const res = await api.post(
        `/users/${id}/deactivate`,
        {},
        { headers: { "X-Step-Up-Token": stepUpToken } }
      );

      setUser(res.data);
    } catch (err) {
      if (err.message !== "step-up cancelled") {
        setError(
          apiErrorMessage(err, "Could not deactivate user.")
        );
      }
    }
  }

  async function handleResetMfa() {
    if (
      !window.confirm(
        `Reset MFA for ${user.fullName}? They will need to re-enroll at next login.`
      )
    ) {
      return;
    }

    setError("");

    try {
      await api.post(`/users/${id}/reset-mfa`);

      setNotice(
        "MFA has been reset. The user will be prompted to re-enroll at next login."
      );
    } catch (err) {
      setError(apiErrorMessage(err, "Could not reset MFA."));
    }
  }

  async function handleRevokeSession(sessionId) {
    if (!window.confirm("Revoke this session?")) return;

    setError("");

    try {
      const stepUpToken = await requestStepUp(
        "revoke a user session"
      );

      await api.delete(`/sessions/${sessionId}`, {
        headers: { "X-Step-Up-Token": stepUpToken },
      });

      setSessions((s) =>
        s.filter((session) => session.id !== sessionId)
      );
    } catch (err) {
      if (err.message !== "step-up cancelled") {
        setError(
          apiErrorMessage(err, "Could not revoke session.")
        );
      }
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (error && !user) return <ErrorText>{error}</ErrorText>;

  if (!user) return null;

  return (
    <div className="w-full min-w-0">
      <button
        onClick={() => navigate("/admin/users")}
        className="mb-4 text-sm text-slate-500 hover:text-slate-700"
      >
        ← Back to users
      </button>

      <PageHeader
        title={user.fullName}
        subtitle={`${user.email} · ${orgName(user.orgId)}`}
        actions={
          <Can permission="user:manage">
            {user.status === "ACTIVE" && (
              <Button
                variant="danger"
                onClick={handleDeactivate}
                className="w-full sm:w-auto"
              >
                Deactivate
              </Button>
            )}
          </Can>
        }
      />

      {notice && (
        <div className="mb-4 wrap-break-words rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      <ErrorText>{error}</ErrorText>

      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="min-w-0 p-4 sm:p-5 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">
            Profile
          </h2>

          <dl className="space-y-3 text-sm">
            <Row label="Role">
              <Can
                permission="user:manage"
                fallback={
                  <Badge className="border-slate-300 bg-slate-100 text-slate-700">
                    {titleCase(user.role)}
                  </Badge>
                }
              >
                {ADMIN_TIER_ROLES.has(user.role) ? (
                  <Badge className="border-slate-400 bg-slate-800 text-white">
                    {titleCase(user.role)}
                  </Badge>
                ) : (
                  <Select
                    value={user.role}
                    onChange={(e) =>
                      updateField("role", e.target.value)
                    }
                    className="py-1! text-xs"
                  >
                    {EDITABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {titleCase(r)}
                      </option>
                    ))}
                  </Select>
                )}
              </Can>
            </Row>

            <Row label="Clearance">
              <Can
                permission="user:manage"
                fallback={
                  <Badge className="border-slate-300 bg-slate-100 text-slate-700">
                    {titleCase(user.clearance)}
                  </Badge>
                }
              >
                <Select
                  value={user.clearance}
                  onChange={(e) =>
                    updateField("clearance", e.target.value)
                  }
                  className="py-1! text-xs"
                >
                  {CLASSIFICATIONS.map((c) => (
                    <option key={c} value={c}>
                      {titleCase(c)}
                    </option>
                  ))}
                </Select>
              </Can>
            </Row>

            <Row label="Jurisdiction">
              <Can
                permission="user:manage"
                fallback={
                  <span className="wrap-break-words">
                    {jurisdictionName(user.jurisdictionId)}
                  </span>
                }
              >
                <div className="w-full sm:w-48">
                  <JurisdictionPicker
                    value={user.jurisdictionId}
                    onChange={(v) =>
                      updateField("jurisdictionId", v)
                    }
                  />
                </div>
              </Can>
            </Row>

            <Row label="Status">
              <Can
                permission="user:manage"
                fallback={
                  <Badge className="border-slate-300 bg-slate-100 text-slate-700">
                    {titleCase(user.status)}
                  </Badge>
                }
              >
                <Select
                  value={user.status}
                  onChange={(e) =>
                    updateField("status", e.target.value)
                  }
                  className="py-1! text-xs"
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {titleCase(s)}
                    </option>
                  ))}
                </Select>
              </Can>
            </Row>

            <Row label="Badge ID">
              {user.badgeId || "—"}
            </Row>

            <Row label="MFA enrolled">
              {user.mfaEnrolled ? "Yes" : "No"}
            </Row>

            <Row label="Last login">
              {formatDate(user.lastLoginAt)}
            </Row>

            <Row label="Created">
              {formatDate(user.createdAt)}
            </Row>
          </dl>

          <Can permission="user:manage">
            <div className="mt-4 border-t border-slate-100 pt-4">
              <Button
                variant="secondary"
                onClick={handleResetMfa}
                className="w-full sm:w-auto"
              >
                Reset MFA enrollment
              </Button>
            </div>
          </Can>
        </Card>

        <Card className="min-w-0 p-4 sm:p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">
            Active sessions
          </h2>

          {sessions.length === 0 ? (
            <p className="text-sm text-slate-500">
              No active sessions.
            </p>
          ) : (
            <ul className="space-y-3">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="rounded-md border border-slate-100 p-3 text-sm"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <span className="break-all text-slate-700">
                      {s.ip || "Unknown IP"}
                    </span>

                    <Can permission="user:manage">
                      <button
                        onClick={() =>
                          handleRevokeSession(s.id)
                        }
                        className="self-start text-xs text-red-600 hover:underline sm:self-auto"
                      >
                        Revoke
                      </button>
                    </Can>
                  </div>

                  <p className="mt-1 wrap-break-words text-xs text-slate-400">
                    Created {formatDate(s.createdAt)}
                    {s.expiresAt && (
                      <> · expires {formatDate(s.expiresAt)}</>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <dt className="shrink-0 text-slate-500">{label}</dt>

      <dd className="min-w-0 max-w-full wrap-wrap-break-words text-left text-slate-900 sm:text-right">
        {children}
      </dd>
    </div>
  );
}