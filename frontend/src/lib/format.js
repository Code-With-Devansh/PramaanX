export const CLASSIFICATIONS = ["PUBLIC", "RESTRICTED", "CONFIDENTIAL", "SECRET"];
export const DOC_TYPES = [
  "FIR",
  "POLICE_REPORT",
  "INVESTIGATION_RECORD",
  "WITNESS_STATEMENT",
  "CHARGE_SHEET",
  "COURT_FILING",
  "EVIDENCE_RECORD",
  "FORENSIC_REPORT",
  "LEGAL_NOTICE",
  "JUDGMENT",
  "OTHER",
];
export const CASE_STATUSES = [
  "OPEN",
  "UNDER_INVESTIGATION",
  "CHARGESHEETED",
  "IN_TRIAL",
  "CLOSED",
  "ARCHIVED",
];
export const ROLES = [
  "INVESTIGATING_OFFICER",
  "SUPERVISOR",
  "PROSECUTOR",
  "JUDGE",
  "COURT_CLERK",
  "FORENSIC_ANALYST",
  "RECORDS_ADMIN",
  "SECURITY_ADMIN",
  "ORG_ADMIN",
  "SYSTEM_ADMIN",
  "AUDITOR",
];

// One-line description of what each role can do here, shown in the sidebar so
// it's obvious at a glance why certain actions are or aren't available.
export const ROLE_DESCRIPTIONS = {
  INVESTIGATING_OFFICER: "Read & upload documents on your cases",
  SUPERVISOR: "Manage cases and documents",
  PROSECUTOR: "Read cases and documents; sign filings",
  JUDGE: "Read cases and documents; sign filings",
  COURT_CLERK: "Read & upload documents on your cases",
  FORENSIC_ANALYST: "Read & upload documents",
  RECORDS_ADMIN: "Manage documents; view users",
  SECURITY_ADMIN: "Audit access; manage users",
  ORG_ADMIN: "Manage users, cases & documents",
  SYSTEM_ADMIN: "Full system access",
  AUDITOR: "Read-only access; audit the system",
};

// The route a user should land on after login. Auditors have little use for
// an empty case list — they live in the audit trail.
export function defaultRouteForRole(role) {
  if (role === "AUDITOR") return "/audit";
  return "/";
}

export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(bytes) {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function titleCase(value) {
  if (!value) return "";
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const CLASSIFICATION_STYLES = {
  PUBLIC: "bg-slate-100 text-slate-700 border-slate-300",
  RESTRICTED: "bg-amber-50 text-amber-800 border-amber-300",
  CONFIDENTIAL: "bg-orange-50 text-orange-800 border-orange-300",
  SECRET: "bg-red-50 text-red-800 border-red-300",
};

export const INTEGRITY_STYLES = {
  VERIFIED: "bg-emerald-50 text-emerald-800 border-emerald-300",
  TAMPERED: "bg-red-50 text-red-800 border-red-300",
  PENDING: "bg-slate-100 text-slate-600 border-slate-300",
};

export const SUDO_ACTION_TYPES = [
  "APPOINT_ORG_ADMIN",
  "REMOVE_ORG_ADMIN",
  "APPOINT_SYSTEM_ADMIN",
  "REMOVE_SYSTEM_ADMIN",
  "CHANGE_POOL_THRESHOLD",
  "ONBOARD_ORG",
  "CHANGE_ABAC_POLICY",
  "POOL_REINSTATEMENT",
];
export const PROPOSAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "OBJECTED", "EXECUTED", "EXPIRED"];
export const POOL_TYPES = ["SYSTEM_ADMIN", "SECURITY_ADMIN", "ORG_ADMIN"];
export const ABAC_POLICY_KEYS = [
  "clearanceRank",
  "elevatedCaseRoles",
  "permissionAliases",
  "permissionsByRole",
];

export const PROPOSAL_STATUS_STYLES = {
  PENDING: "bg-amber-50 text-amber-800 border-amber-300",
  APPROVED: "bg-blue-50 text-blue-800 border-blue-300",
  EXECUTED: "bg-emerald-50 text-emerald-800 border-emerald-300",
  OBJECTED: "bg-red-50 text-red-800 border-red-300",
  REJECTED: "bg-red-50 text-red-800 border-red-300",
  EXPIRED: "bg-slate-100 text-slate-600 border-slate-300",
};
