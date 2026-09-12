import { useEffect, useState } from "react";

import { api } from "../lib/api";

import { titleCase } from "../lib/format";

import { useReference } from "../lib/ReferenceContext";

// Single-select: value is a userId string, onChange(userId, userObj).
// Multi-select: value is an array of userIds, onChange(userIds, userObjs).
export default function UserPicker({
  label,
  multi = false,
  value,
  onChange,
  placeholder,
}) {
  const [q, setQ] = useState("");

  const [results, setResults] = useState([]);

  const [picked, setPicked] = useState(multi ? [] : null); // user objects, for display

  const { orgName } = useReference();

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
        // best-effort search
      }
    }, 300);

    return () => clearTimeout(handle);
  }, [q]);

  function pick(user) {
    if (multi) {
      const next = [...picked, user];

      setPicked(next);

      onChange(
        next.map((u) => u.id),
        next
      );

      setQ("");

      setResults([]);
    } else {
      setPicked(user);

      onChange(user.id, user);

      setQ(user.fullName);

      setResults([]);
    }
  }

  function removePicked(userId) {
    const next = picked.filter((u) => u.id !== userId);

    setPicked(next);

    onChange(
      next.map((u) => u.id),
      next
    );
  }

  return (
    <div className="w-full min-w-0">
      <label className="block min-w-0">
        {label && (
          <span className="mb-1 block text-sm font-medium text-slate-700">
            {label}
          </span>
        )}

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder || "Search by name or email…"}
          className="w-full min-w-0 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-600"
        />
      </label>

      {results.length > 0 && (
        <ul className="mt-1 max-h-40 min-w-0 divide-y divide-slate-100 overflow-x-hidden overflow-y-auto rounded-md border border-slate-200">
          {results.map((u) => (
            <li key={u.id} className="min-w-0">
              <button
                type="button"
                onClick={() => pick(u)}
                className="block w-full min-w-0 px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <span className="wrap-break-words font-medium text-slate-900">
                  {u.fullName}
                </span>{" "}
                <span className="wrap-break-words text-slate-500">
                  · {titleCase(u.role)} · {orgName(u.orgId)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {multi && picked.length > 0 && (
        <ul className="mt-2 min-w-0 space-y-1">
          {picked.map((u) => (
            <li
              key={u.id}
              className="flex min-w-0 flex-col gap-1 rounded-md bg-slate-50 px-2 py-2 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-2"
            >
              <span className="min-w-0 wrap-break-words">
                {u.fullName}{" "}
                <span className="text-slate-400">
                  · {titleCase(u.role)}
                </span>
              </span>

              <button
                type="button"
                onClick={() => removePicked(u.id)}
                className="self-start shrink-0 text-red-600 hover:underline sm:self-auto"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}