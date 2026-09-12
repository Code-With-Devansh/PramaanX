import { useCallback, useEffect, useRef, useState } from "react";

import { useNavigate } from "react-router-dom";

import { api } from "../lib/api";

import { formatDate } from "../lib/format";

import { Spinner } from "./ui";

const POLL_MS = 30_000;

export default function NotificationsBell() {
  const [open, setOpen] = useState(false);

  const [items, setItems] = useState([]);

  const [loading, setLoading] = useState(true);

  const [error, setError] = useState("");

  const containerRef = useRef(null);

  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const res = await api.get("/notifications", {
        params: { page: 1, pageSize: 20 },
      });

      setItems(res.data.items);

      setError("");
    } catch (err) {
      setError("Could not load notifications.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();

    const interval = setInterval(load, POLL_MS);

    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    function onClickOutside(e) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", onClickOutside);

    return () =>
      document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const unreadCount = items.filter((n) => !n.read).length;

  async function handleOpenNotification(n) {
    setOpen(false);

    if (!n.read) {
      try {
        await api.post(`/notifications/${n.id}/read`);

        setItems((prev) =>
          prev.map((x) =>
            x.id === n.id ? { ...x, read: true } : x
          )
        );
      } catch {
        // best-effort
      }
    }

    if (n.link) navigate(n.link);
  }

  async function handleMarkAllRead() {
    try {
      await api.post("/notifications/read-all");

      setItems((prev) =>
        prev.map((n) => ({ ...n, read: true }))
      );
    } catch {
      // best-effort
    }
  }

  return (
    <div
      className="relative min-w-0"
      ref={containerRef}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-full border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50"
        aria-label="Notifications"
      >
        <BellIcon />

        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[calc(100vw-2rem)] max-w-80 min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg sm:w-80">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2">
            <h3 className="text-sm font-semibold text-slate-900">
              Notifications
            </h3>

            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-xs font-medium text-blue-700 hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : error ? (
              <p className="wrap-break-words px-4 py-4 text-sm text-red-600">
                {error}
              </p>
            ) : items.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-slate-500">
                You're all caught up.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => handleOpenNotification(n)}
                      className={`block w-full min-w-0 px-4 py-3 text-left text-sm hover:bg-slate-50 ${
                        n.read
                          ? "text-slate-600"
                          : "bg-blue-50/60 font-medium text-slate-900"
                      }`}
                    >
                      <p className="wrap-break-words">
                        {n.message}
                      </p>

                      <p className="mt-1 wrap-break-words text-xs font-normal text-slate-400">
                        {formatDate(n.createdAt)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-5 w-5"
    >
      <path
        d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <path
        d="M13.73 21a2 2 0 0 1-3.46 0"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}