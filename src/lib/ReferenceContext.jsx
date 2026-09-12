import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";

// The backend stores orgs/jurisdictions as lookup tables (id, name, ...) and
// every other record (users, cases, proposals) references them by id — NOT by
// name. This context loads both lists once (GET /orgs, GET /jurisdictions —
// each returns a bare array, not a paginated {items} envelope) so the rest of
// the app can resolve an orgId/jurisdictionId to a human-readable name instead
// of rendering a raw UUID or a stale free-text field.
//
// Loading these lists requires "reference:read" (SYSTEM_ADMIN / SECURITY_ADMIN
// today per the default ABAC policy — see abacPolicy.js on the backend). Other
// roles will 403; we swallow that quietly and fall back to showing ids, since
// not every role needs to resolve names to do their job.
const ReferenceContext = createContext(null);

export function ReferenceProvider({ children }) {
  const [orgs, setOrgs] = useState([]);
  const [jurisdictions, setJurisdictions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [orgsRes, jurisRes] = await Promise.all([
        api.get("/orgs"),
        api.get("/jurisdictions"),
      ]);
      setOrgs(orgsRes.data);
      setJurisdictions(jurisRes.data);
      setForbidden(false);
    } catch (err) {
      if (err.response?.status === 403) {
        setForbidden(true);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  function orgName(id) {
    if (!id) return "—";
    return orgs.find((o) => o.id === id)?.name || id;
  }

  function jurisdictionName(id) {
    if (!id) return "—";
    return jurisdictions.find((j) => j.id === id)?.name || id;
  }

  const value = { orgs, jurisdictions, loading, forbidden, orgName, jurisdictionName, reload };

  return <ReferenceContext.Provider value={value}>{children}</ReferenceContext.Provider>;
}

export function useReference() {
  const ctx = useContext(ReferenceContext);
  if (!ctx) throw new Error("useReference must be used within ReferenceProvider");
  return ctx;
}
