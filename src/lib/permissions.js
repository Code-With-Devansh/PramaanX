// Mirrors DEFAULT_POLICY.permissionAliases in the backend's src/lib/abacPolicy.js.
// user.permissions (from /auth/me) is the RAW list for the role — e.g. SUPERVISOR
// has "case:manage", not "case:create" — so an action like "case:create" is only
// granted via this alias table, same as the server-side authorize() check.
export const PERMISSION_ALIASES = {
  "user:read": ["user:read", "user:manage"],
  "user:manage": ["user:manage"],
  "case:list": ["case:list", "case:read", "cases:read"],
  "case:read": ["case:read", "cases:read"],
  "case:create": ["case:create", "case:manage", "cases:manage"],
  "case:update": ["case:update", "case:manage", "cases:manage"],
  "case:manage": ["case:manage", "cases:manage"],
  "case:legal-hold": ["case:legal-hold", "case:manage", "cases:manage"],
  "document:read": ["document:read", "documents:read"],
  "document:list": ["document:list", "document:read", "documents:read"],
  "document:download": ["document:download", "document:read", "documents:read"],
  "document:create": ["document:create", "document:write", "documents:write"],
  "document:add-version": ["document:add-version", "document:write", "documents:write"],
  "document:restore": ["document:restore", "document:write", "documents:write"],
  "document:sign": ["document:sign", "documents:sign"],
  "document:seal": ["document:seal", "document:manage", "documents:manage"],
  "document:delete": ["document:delete", "document:manage", "documents:manage"],
  "document:share": ["document:share", "document:manage", "documents:manage"],
  "governance:read": ["governance:read"],
  "governance:propose": ["governance:propose"],
  "governance:approve": ["governance:approve"],
  "governance:vote": ["governance:vote"],
  "audit:read": ["audit:read"],
  "audit:verify": ["audit:verify"],
  "reference:read": ["reference:read", "reference:manage"],
  "reference:manage": ["reference:manage"],
};

export function permissionGrants(userPermissions, action) {
  if (!userPermissions) return false;
  if (userPermissions.includes("*")) return true;
  const required = PERMISSION_ALIASES[action] || [action];
  return required.some((p) => userPermissions.includes(p));
}
