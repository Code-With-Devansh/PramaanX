import { useState } from "react";
import { api } from "../../lib/api";
import { useReference } from "../../lib/ReferenceContext";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Input,
  PageHeader,
  apiErrorMessage,
} from "../../components/ui";
import { Can } from "../../components/guards";

const TABS = [
  { key: "orgs", label: "Organizations", endpoint: "/orgs" },
  { key: "jurisdictions", label: "Jurisdictions", endpoint: "/jurisdictions" },
];

export default function ReferenceAdmin() {
  const [tab, setTab] = useState("orgs");
  const { orgs, jurisdictions, reload } = useReference();
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState("");

  const active = TABS.find((t) => t.key === tab);
  const items = tab === "orgs" ? orgs : jurisdictions;

  async function handleToggleActive(item) {
    setError("");
    try {
      await api.patch(`${active.endpoint}/${item.id}`, { active: !item.active });
      await reload();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not update this entry."));
    }
  }

  async function handleDelete(item) {
    if (!window.confirm(`Delete "${item.name}"? This can't be undone.`)) return;
    setError("");
    try {
      await api.delete(`${active.endpoint}/${item.id}`);
      await reload();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not delete this entry — it may still be in use."));
    }
  }

  return (
    <div>
      <PageHeader
        title="Reference Data"
        subtitle="Organizations and jurisdictions are the lookup values used across cases and user accounts."
        actions={
          <Can permission="reference:manage">
            <Button onClick={() => setShowNew(true)}>New {tab === "orgs" ? "organization" : "jurisdiction"}</Button>
          </Can>
        }
      />

      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm font-medium ${
              tab === t.key
                ? "border-b-2 border-blue-700 text-blue-700"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ErrorText>{error}</ErrorText>

      {items.length === 0 ? (
        <EmptyState title={`No ${active.label.toLowerCase()} yet`} />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-900">{item.name}</td>
                  <td className="px-4 py-3 text-slate-600">{item.description || "—"}</td>
                  <td className="px-4 py-3">
                    <Badge
                      className={
                        item.active
                          ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                          : "border-slate-300 bg-slate-100 text-slate-600"
                      }
                    >
                      {item.active ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Can permission="reference:manage">
                      <button
                        onClick={() => handleToggleActive(item)}
                        className="mr-3 text-xs font-medium text-blue-700 hover:underline"
                      >
                        {item.active ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        onClick={() => handleDelete(item)}
                        className="text-xs font-medium text-red-600 hover:underline"
                      >
                        Delete
                      </button>
                    </Can>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {showNew && (
        <NewReferenceDialog
          kind={tab === "orgs" ? "organization" : "jurisdiction"}
          endpoint={active.endpoint}
          onClose={() => setShowNew(false)}
          onCreated={async () => {
            setShowNew(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function NewReferenceDialog({ kind, endpoint, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post(endpoint, { name, description: description || undefined });
      onCreated();
    } catch (err) {
      setError(apiErrorMessage(err, `Could not create this ${kind}.`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold capitalize text-slate-900">New {kind}</h2>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Description <span className="text-slate-400">(optional)</span>
            </span>
            <textarea
              rows={2}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-600"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
