import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, setAccessToken, clearSession, refreshAccessToken } from "./api";
import { permissionGrants } from "./permissions";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // Me: { id, fullName, role, permissions, ... }
  const [status, setStatus] = useState("loading"); // loading | authenticated | anonymous

  const fetchMe = useCallback(async () => {
    const res = await api.get("/auth/me");
    setUser(res.data.user);
    return res.data.user;
  }, []);

  // On app load, try to silently restore a session via the refresh cookie.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await refreshAccessToken();
        const me = await fetchMe();
        if (!cancelled) {
          setUser(me);
          setStatus("authenticated");
        }
      } catch {
        if (!cancelled) {
          setStatus("anonymous");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchMe]);

  useEffect(() => {
    function onExpired() {
      clearSession();
      setUser(null);
      setStatus("anonymous");
    }
    window.addEventListener("dms:session-expired", onExpired);
    return () => window.removeEventListener("dms:session-expired", onExpired);
  }, []);

  // Step 1 of login: username/password -> may require MFA.
  const login = useCallback(async (username, password) => {
    const res = await api.post("/auth/login", { username, password });
    return res.data; // { mfaRequired, user? }
  }, []);

  // Step 2: TOTP/FIDO2 code -> issues access token + refresh cookie.
  const verifyMfa = useCallback(
    async (code) => {
      const res = await api.post("/auth/mfa/verify", { code });
      setAccessToken(res.data.accessToken);
      setUser(res.data.user);
      setStatus("authenticated");
      return res.data.user;
    },
    []
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      clearSession();
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  const hasPermission = useCallback(
    (action) => permissionGrants(user?.permissions, action),
    [user]
  );

  const hasRole = useCallback(
    (...roles) => {
      if (!user) return false;
      return roles.includes(user.role);
    },
    [user]
  );

  const value = {
    user,
    status,
    isAuthenticated: status === "authenticated",
    login,
    verifyMfa,
    logout,
    hasPermission,
    hasRole,
    refreshMe: fetchMe,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
