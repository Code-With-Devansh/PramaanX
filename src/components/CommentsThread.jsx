import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { formatDate } from "../lib/format";
import { Button, ErrorText, Spinner, apiErrorMessage } from "./ui";

// Mounts a comment thread against either a case or a document. Pass exactly
// one of caseId / documentId — mirrors the backend's two mounting points for
// the same comments resource (POST/GET /cases/:caseId/comments vs
// /documents/:id/comments), while edit/delete always hit /comments/:commentId
// regardless of which thread the comment lives in.
export default function CommentsThread({ caseId, documentId }) {
  const { user } = useAuth();
  const listEndpoint = documentId ? `/documents/${documentId}/comments` : `/cases/${caseId}/comments`;

  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editBody, setEditBody] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get(listEndpoint);
      setComments(res.data.items);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not load comments."));
    } finally {
      setLoading(false);
    }
  }, [listEndpoint]);

  useEffect(() => {
    load();
  }, [load]);

  async function submit(e) {
    e.preventDefault();
    if (!body.trim()) return;
    setPosting(true);
    setError("");
    try {
      await api.post(listEndpoint, { body: body.trim() });
      setBody("");
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not post comment."));
    } finally {
      setPosting(false);
    }
  }

  async function saveEdit(commentId) {
    if (!editBody.trim()) return;
    setError("");
    try {
      await api.patch(`/comments/${commentId}`, { body: editBody.trim() });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not save changes."));
    }
  }

  async function handleDelete(commentId) {
    if (!window.confirm("Delete this comment?")) return;
    setError("");
    try {
      await api.delete(`/comments/${commentId}`);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not delete comment."));
    }
  }

  return (
    <div>
      <ErrorText>{error}</ErrorText>

      {loading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : comments.length === 0 ? (
        <p className="mb-4 text-sm text-slate-500">No comments yet.</p>
      ) : (
        <ul className="mb-4 space-y-3">
          {comments.map((c) => {
            const mine = c.author?.id === user?.id;
            return (
              <li key={c.id} className="rounded-md border border-slate-100 bg-slate-50 p-3 text-sm">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-mono text-xs text-slate-500">{c.author?.id}</span>
                  <span className="text-xs text-slate-400">
                    {formatDate(c.createdAt)}
                    {c.editedAt ? " (edited)" : ""}
                  </span>
                </div>
                {editingId === c.id ? (
                  <div className="space-y-2">
                    <textarea
                      rows={2}
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-600"
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button className="px-2 py-1 text-xs" onClick={() => saveEdit(c.id)}>
                        Save
                      </Button>
                      <Button
                        variant="secondary"
                        className="px-2 py-1 text-xs"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="whitespace-pre-wrap text-slate-800">{c.body}</p>
                    {mine && (
                      <div className="mt-2 flex gap-3">
                        <button
                          onClick={() => {
                            setEditingId(c.id);
                            setEditBody(c.body);
                          }}
                          className="text-xs font-medium text-blue-700 hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(c.id)}
                          className="text-xs font-medium text-red-600 hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={submit} className="flex gap-2">
        <textarea
          rows={2}
          placeholder="Write a comment… use @username to mention someone with access."
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-600"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <Button type="submit" disabled={posting || !body.trim()}>
          {posting ? "Posting…" : "Post"}
        </Button>
      </form>
    </div>
  );
}
