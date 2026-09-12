import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { ROLES, formatDate, titleCase } from "../../lib/format";
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
} from "../../components/ui";
import { Can } from "../../components/guards";
import NewUserDialog from "./NewUserDialog";
import { useReference } from "../../lib/ReferenceContext";

export default function UsersList() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showNew, setShowNew] = useState(false);
  const { orgName } = useReference();
  const pageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/users", {
        params: { page, pageSize, q: q || undefined, role: role || undefined },
      });
      setItems(res.data.items);
      setTotal(res.data.total);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not load users."));
    } finally {
      setLoading(false);
    }
  }, [page, q, role]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Accounts provisioned for this agency."
        actions={
          <Can permission="user:manage">
            <Button onClick={() => setShowNew(true)}>New user</Button>
          </Can>
        }
      />

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <Input
              label="Search"
              placeholder="Name, email…"
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
            />
          </div>
          <div className="w-56">
            <Select
              label="Role"
              value={role}
              onChange={(e) => {
                setPage(1);
                setRole(e.target.value);
              }}
            >
              <option value="">All roles</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      <ErrorText>{error}</ErrorText>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="No users found" />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Org</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Last login</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link to={`/admin/users/${u.id}`} className="font-medium text-blue-700 hover:underline">
                      {u.fullName}
                    </Link>
                    <p className="text-xs text-slate-400">{u.email}</p>
                  </td>
                  <td className="px-4 py-3 text-slate-700">{titleCase(u.role)}</td>
                  <td className="px-4 py-3 text-slate-600">{orgName(u.orgId)}</td>
                  <td className="px-4 py-3">
                    <Badge
                      className={
                        u.status === "ACTIVE"
                          ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                          : "border-slate-300 bg-slate-100 text-slate-600"
                      }
                    >
                      {titleCase(u.status)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(u.lastLoginAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
          <span>
            Page {page} of {totalPages} · {total} users
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
        <NewUserDialog
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
