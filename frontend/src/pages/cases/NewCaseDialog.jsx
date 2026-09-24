
import { useState } from "react";

import { api } from "../../lib/api";

import { useAuth } from "../../lib/AuthContext";

import { CLASSIFICATIONS, titleCase } from "../../lib/format";

import {
  Button,
  ErrorText,
  Input,
  Select,
  apiErrorMessage,
} from "../../components/ui";

import { useReference } from "../../lib/ReferenceContext";

export default function NewCaseDialog({ onClose, onCreated }) {
  const { user } = useAuth();
  const { jurisdictionName } = useReference();

  const [form, setForm] = useState({
    caseNumber: "",
    title: "",
    type: "",
    classification: "RESTRICTED",
    // New cases are always filed under the creating user's own jurisdiction —
    // it's not a free choice, so we seed it from the session and never let
    // the picker be edited (see JurisdictionPicker below).
    jurisdictionId: user?.jurisdictionId || "",
    description: "",
  });

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");

    try {
      const res = await api.post("/cases", form);
      onCreated(res.data);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not create case."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/50 px-4 py-4 sm:py-6">
      <div className="w-full max-w-lg rounded-lg bg-white p-4 shadow-xl sm:p-6">
        <h2 className="text-lg font-semibold text-slate-900">
          New case
        </h2>

        <form className="mt-4 space-y-4" onSubmit={submit}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label="Case number"
              required
              value={form.caseNumber}
              onChange={(e) => set("caseNumber", e.target.value)}
            />

            <Input
              label="Case type"
              required
              placeholder="e.g. Criminal"
              value={form.type}
              onChange={(e) => set("type", e.target.value)}
            />
          </div>

          <Input
            label="Title"
            required
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              label="Classification"
              value={form.classification}
              onChange={(e) => set("classification", e.target.value)}
            >
              {CLASSIFICATIONS.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>

            <Input
              label="Jurisdiction"
              value={jurisdictionName(form.jurisdictionId)}
              disabled
              readOnly
              className="bg-slate-100 text-slate-600"
            />
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Description
            </span>

            <textarea
              rows={3}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-600"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </label>

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
              {busy ? "Creating…" : "Create case"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}


