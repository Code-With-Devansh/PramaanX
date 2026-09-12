import { useState } from "react";
import { api } from "../../lib/api";
import { CLASSIFICATIONS, DOC_TYPES, titleCase } from "../../lib/format";
import {
  Button,
  ErrorText,
  Input,
  Select,
  apiErrorMessage,
} from "../../components/ui";
export default function UploadDocumentDialog({ caseId, onClose, onUploaded }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState(DOC_TYPES[0]);
  const [classification, setClassification] = useState("RESTRICTED");
  const [description, setDescription] = useState("");
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
        JSON.stringify({
          title,
          docType,
          classification,
          description: description || undefined,
        }),
      );
      const res = await api.post(`/cases/${caseId}/documents`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      onUploaded(res.data);
    } catch (err) {
      setError(apiErrorMessage(err, "Upload failed."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/50 px-4 py-4 sm:py-6">
      {" "}
      <div className="w-full max-w-lg rounded-lg bg-white p-4 shadow-xl sm:p-6">
        {" "}
        <h2 className="text-lg font-semibold text-slate-900">
          {" "}
          Upload document{" "}
        </h2>{" "}
        <form onSubmit={submit} className="mt-4 space-y-4">
          {" "}
          <label className="block">
            {" "}
            <span className="mb-1 block text-sm font-medium text-slate-700">
              {" "}
              File{" "}
            </span>{" "}
            <input
              type="file"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
            />{" "}
          </label>{" "}
          <Input
            label="Title"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />{" "}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {" "}
            <Select
              label="Document type"
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
            >
              {" "}
              {DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {" "}
                  {titleCase(t)}{" "}
                </option>
              ))}{" "}
            </Select>{" "}
            <Select
              label="Classification"
              value={classification}
              onChange={(e) => setClassification(e.target.value)}
            >
              {" "}
              {CLASSIFICATIONS.map((c) => (
                <option key={c} value={c}>
                  {" "}
                  {titleCase(c)}{" "}
                </option>
              ))}{" "}
            </Select>{" "}
          </div>{" "}
          <label className="block">
            {" "}
            <span className="mb-1 block text-sm font-medium text-slate-700">
              {" "}
              Description{" "}
              <span className="text-slate-400">(optional)</span>{" "}
            </span>{" "}
            <textarea
              rows={2}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-600"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />{" "}
          </label>{" "}
          <ErrorText>{error}</ErrorText>{" "}
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            {" "}
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              className="w-full sm:w-auto"
            >
              {" "}
              Cancel{" "}
            </Button>{" "}
            <Button type="submit" disabled={busy} className="w-full sm:w-auto">
              {" "}
              {busy ? "Uploading…" : "Upload"}{" "}
            </Button>{" "}
          </div>{" "}
        </form>{" "}
      </div>{" "}
    </div>
  );
}
