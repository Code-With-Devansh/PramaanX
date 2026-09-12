import { useState } from "react";

import { api } from "../../lib/api";

import { Button, ErrorText, apiErrorMessage } from "../../components/ui";

export default function AddVersionDialog({ documentId, onClose, onAdded }) {
  const [file, setFile] = useState(null);

  const [note, setNote] = useState("");

  const [error, setError] = useState("");

  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();

    if (!file) {
      setError("Choose a file to upload.");
      return;
    }

    setBusy(true);
    setError("");

    try {
      const formData = new FormData();

      formData.append("file", file);

      formData.append(
        "metadata",
        JSON.stringify({ note: note || undefined })
      );

      await api.post(`/documents/${documentId}/versions`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      onAdded();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not add version."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/50 px-4 py-4 sm:py-6">
      <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl sm:p-6">
        <h2 className="text-lg font-semibold text-slate-900">
          Add new version
        </h2>

        <form onSubmit={submit} className="mt-4 space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              File
            </span>

            <input
              type="file"
              required
              onChange={(e) =>
                setFile(e.target.files?.[0] ?? null)
              }
              className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Note{" "}
              <span className="text-slate-400">(optional)</span>
            </span>

            <textarea
              rows={2}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-600"
              value={note}
              onChange={(e) => setNote(e.target.value)}
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
              {busy ? "Uploading…" : "Add version"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}