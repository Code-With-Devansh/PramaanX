import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { Spinner } from "./ui";

export function ProtectedRoute({ children, roles, permission }) {
  const { status, isAuthenticated, hasRole, hasPermission } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (roles && roles.length > 0 && !hasRole(...roles)) {
    return <Navigate to="/" replace />;
  }

  if (permission && !hasPermission(permission)) {
    return <Navigate to="/" replace />;
  }

  return children;
}

// Renders children only if the current user has the given permission or role.
export function Can({ permission, roles, children, fallback = null }) {
  const { hasPermission, hasRole } = useAuth();
  const allowed = permission ? hasPermission(permission) : roles ? hasRole(...roles) : true;
  return allowed ? children : fallback;
}
