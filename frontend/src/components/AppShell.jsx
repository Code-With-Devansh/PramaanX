import { NavLink, Outlet } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../lib/AuthContext";
import { useReference } from "../lib/ReferenceContext";
import { ROLE_DESCRIPTIONS, titleCase } from "../lib/format";
import { Can } from "./guards";
import NotificationsBell from "./NotificationsBell";

const navItems = [
  { to: "/", label: "Cases", end: true },
  { to: "/search", label: "Search" },
  { to: "/governance", label: "Governance", permission: "governance:read" },
  { to: "/audit", label: "Audit Log", permission: "audit:read" },
  { to: "/admin/users", label: "Users", permission: "user:read" },
  {
    to: "/admin/reference",
    label: "Reference Data",
    permission: "reference:read",
  },
];

export default function AppShell() {
  const { user, logout } = useAuth();
  const { orgName } = useReference();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* //for responsive */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={`
    fixed inset-y-0 left-0 z-50
    flex w-60 shrink-0 flex-col
    border-r border-slate-200 bg-white
    transition-transform duration-300
    lg:static lg:translate-x-0
    ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
  `}
      >
        <div className="flex h-16 items-center justify-between gap-2 border-b border-slate-200 px-5">
          <div className="flex items-center">
           
            <div className="leading-tight">
             <h1 className="text-[#173B6C] text-3xl font-bold tracking-[0.08em] font-sans">
  CASETRACE
</h1>
              <p className="text-[11px] text-slate-500">
                Legal &amp; Investigation Records
              </p>
            </div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-4">
          {navItems.map((item) =>
            item.permission ? (
              <Can key={item.to} permission={item.permission}>
                <NavItem {...item} onClick={() => setSidebarOpen(false)} />
              </Can>
            ) : (
              <NavItem
                key={item.to}
                {...item}
                onClick={() => setSidebarOpen(false)}
              />
            ),
          )}
        </nav>
        <div className="border-t border-slate-200 p-4">
          <p className="truncate text-sm font-medium text-slate-900">
            {user?.fullName}
          </p>
          <p className="truncate text-xs text-slate-500">
            {titleCase(user?.role)} · {orgName(user?.orgId)}
          </p>
          {user?.role && ROLE_DESCRIPTIONS[user.role] && (
            <p className="mt-1 text-[11px] leading-snug text-slate-400">
              {ROLE_DESCRIPTIONS[user.role]}
            </p>
          )}
          <button
            onClick={logout}
            className="mt-3 w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4 lg:hidden">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="rounded-md p-2 text-slate-600 hover:bg-slate-100"
            aria-label="Open navigation"
          >
            ☰
          </button>

          <p className="text-sm font-semibold text-slate-900"> CASETRACE</p>

          <NotificationsBell />
        </header>
        <div className="mx-auto max-w-[1800px] px-4 sm:px-5 md:px-6 py-4">
          <div className="mb-2 flex justify-end">
            <NotificationsBell />
          </div>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function NavItem({ to, label, end, onClick }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      className={({ isActive }) =>
        `block rounded-md px-3 py-2 text-sm font-medium ${
          isActive
            ? "bg-blue-50 text-blue-800"
            : "text-slate-600 hover:bg-slate-100"
        }`
      }
    >
      {label}
    </NavLink>
  );
}
