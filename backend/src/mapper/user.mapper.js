import { getActivePolicySync } from "../lib/abacPolicy.js";

// Role → permissions used to be a module constant here. It now lives in the ABAC
// policy overlay (src/lib/abacPolicy.js, DEFAULT_POLICY.permissionsByRole) so a
// CHANGE_ABAC_POLICY proposal can adjust it. getActivePolicySync() returns the
// last-refreshed merged policy synchronously; the enforcement path (authorize)
// refreshes it before mapping, so guarded decisions use the current permissions.

export function toMe(user) {
    const permissionsByRole = getActivePolicySync().permissionsByRole;
    return {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        orgId: user.orgId,
        badgeId: user.badgeId,
        email: user.email,
        clearance: user.clearance,
        jurisdictionId: user.jurisdictionId,
        status: user.status,
        mfaEnrolled: user.mfaEnrolled,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        permissions: permissionsByRole[user.role] ?? [],
    };
}
