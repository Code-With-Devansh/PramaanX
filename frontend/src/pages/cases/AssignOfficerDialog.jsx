
import { useEffect, useState } from "react";

import { api } from "../../lib/api";

import { ROLES, titleCase } from "../../lib/format";

import {
  Button,
  ErrorText,
  Input,
  Select,
  apiErrorMessage,
} from "../../components/ui";

export default function AssignOfficerDialog({ caseId, onClose, onAssigned }) {
  const [q, setQ] = useState("");

  const [results, setResults] = useState([]);

  const [selectedUserId, setSelectedUserId] = useState("");

  const [roleOnCase, setRoleOnCase] = useState("INVESTIGATING_OFFICER");

  const [error, setError] = useState("");

  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handle = setTimeout(async () => {
      if (!q.trim()) {
        setResults([]);
        return;
      }

      try {
        const res = await api.get("/users", {
          params: { q, pageSize: 10 },
        });

        setResults(res.data.items);
      } catch {
        // silent — search is best-effort
      }
    }, 300);

    return () => clearTimeout(handle);
  }, [q]);

  async function submit(e) {
    e.preventDefault();

    if (!selectedUserId) {
      setError("Select a user to assign.");
      return;
    }

    setBusy(true);
    setError("");

    try {
      await api.post(`/cases/${caseId}/officers`, {
        userId: selectedUserId,
        roleOnCase,
      });

      onAssigned();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not assign officer."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/50 px-4 py-4 sm:py-6">
      <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl sm:p-6">
        <h2 className="text-lg font-semibold text-slate-900">
          Assign officer to case
        </h2>

        <form onSubmit={submit} className="mt-4 space-y-4">
          <Input
            label="Search by name or email"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSelectedUserId("");
            }}
            placeholder="Start typing…"
          />

          {results.length > 0 && (
            <ul className="max-h-40 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
              {results.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedUserId(u.id);
                      setQ(u.fullName);
                      setResults([]);
                    }}
                    className={`block w-full px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                      selectedUserId === u.id ? "bg-blue-50" : ""
                    }`}
                  >
                    <span className="wrap-break-words font-medium text-slate-900">
                      {u.fullName}
                    </span>{" "}
                    <span className="text-slate-500">
                      · {titleCase(u.role)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <Select
            label="Role on this case"
            value={roleOnCase}
            onChange={(e) => setRoleOnCase(e.target.value)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {titleCase(r)}
              </option>
            ))}
          </Select>

          <ErrorText>{error}</ErrorText>

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>

            <Button
              type="submit"
              disabled={busy}
              className="w-full sm:w-auto"
            >
              {busy ? "Assigning…" : "Assign"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

