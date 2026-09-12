import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { CLASSIFICATIONS, DOC_TYPES, titleCase } from "../lib/format";
import {
  Card,
  ClassificationBadge,
  EmptyState,
  ErrorText,
  Input,
  PageHeader,
  Select,
  Spinner,
  apiErrorMessage,
} from "../components/ui";

// GET /search requires at least one of q/caseId/docType/classification/tags —
// we simply don't fire the request until the person has entered something.
export default function Search() {
  const [q, setQ] = useState("");
  const [docType, setDocType] = useState("");
  const [classification, setClassification] = useState("");
  const [results, setResults] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const hasCriteria = q.trim() || docType || classification;

  const run = useCallback(async () => {
    if (!hasCriteria) {
      setResults(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/search", {
        params: {
          q: q.trim() || undefined,
          docType: docType || undefined,
          classification: classification || undefined,
          page: 1,
          pageSize: 20,
        },
      });
      setResults(res.data.results);
      setTotal(res.data.total);
    } catch (err) {
      setError(apiErrorMessage(err, "Search failed."));
    } finally {
      setLoading(false);
    }
  }, [q, docType, classification, hasCriteria]);

  useEffect(() => {
    const handle = setTimeout(run, 350);
    return () => clearTimeout(handle);
  }, [run]);

  return (
    <div>
      <PageHeader title="Search" subtitle="Search documents you have access to across every case." />

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <Input
              label="Keywords"
              placeholder="Title, description, extracted text, tags…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
          </div>
          <div className="w-48">
            <Select label="Document type" value={docType} onChange={(e) => setDocType(e.target.value)}>
              <option value="">Any type</option>
              {DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-48">
            <Select
              label="Classification"
              value={classification}
              onChange={(e) => setClassification(e.target.value)}
            >
              <option value="">Any classification</option>
              {CLASSIFICATIONS.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      <ErrorText>{error}</ErrorText>

      {!hasCriteria ? (
        <EmptyState title="Enter a search" subtitle="Type keywords or pick a filter to search documents." />
      ) : loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : results && results.length === 0 ? (
        <EmptyState title="No matching documents" subtitle="Try different keywords or filters." />
      ) : results ? (
        <>
          <p className="mb-2 text-xs text-slate-500">{total} result{total === 1 ? "" : "s"}</p>
          <Card className="overflow-hidden">
            <div className="divide-y divide-slate-100">
              {results.map((r) => (
                <Link
                  key={r.documentId}
                  to={`/documents/${r.documentId}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{r.title}</p>
                    <p className="text-xs text-slate-500">
                      {titleCase(r.docType)}
                      {r.tags?.length ? ` · ${r.tags.join(", ")}` : ""}
                    </p>
                  </div>
                  <ClassificationBadge value={r.classification} />
                </Link>
              ))}
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
