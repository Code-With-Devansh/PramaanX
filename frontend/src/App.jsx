import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./lib/AuthContext";
import { StepUpProvider } from "./lib/StepUpContext";
import { ReferenceProvider } from "./lib/ReferenceContext";
import { ProtectedRoute } from "./components/guards";
import AppShell from "./components/AppShell";

import Login from "./pages/auth/Login";
import MfaEnroll from "./pages/auth/MfaEnroll";
import Activate from "./pages/auth/Activate";
import CasesList from "./pages/cases/CasesList";
import CaseDetail from "./pages/cases/CaseDetail";
import DocumentDetail from "./pages/documents/DocumentDetail";
import UsersList from "./pages/admin/UsersList";
import UserDetail from "./pages/admin/UserDetail";
import ReferenceAdmin from "./pages/admin/ReferenceAdmin";
import Audit from "./pages/Audit";
import Search from "./pages/Search";
import ProposalsList from "./pages/governance/ProposalsList";
import ProposalDetail from "./pages/governance/ProposalDetail";
import NotFound from "./pages/NotFound";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <StepUpProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/mfa-enroll" element={<MfaEnroll />} />
            <Route path="/activate" element={<Activate />} />

            <Route
              element={
                <ProtectedRoute>
                  <ReferenceProvider>
                    <AppShell />
                  </ReferenceProvider>
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<CasesList />} />
              <Route path="/cases/:id" element={<CaseDetail />} />
              <Route path="/documents/:id" element={<DocumentDetail />} />
              <Route path="/search" element={<Search />} />
              <Route
                path="/admin/users"
                element={
                  <ProtectedRoute permission="user:read">
                    <UsersList />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/users/:id"
                element={
                  <ProtectedRoute permission="user:read">
                    <UserDetail />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/reference"
                element={
                  <ProtectedRoute permission="reference:read">
                    <ReferenceAdmin />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/audit"
                element={
                  <ProtectedRoute permission="audit:read">
                    <Audit />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/governance"
                element={
                  <ProtectedRoute permission="governance:read">
                    <ProposalsList />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/governance/:id"
                element={
                  <ProtectedRoute permission="governance:read">
                    <ProposalDetail />
                  </ProtectedRoute>
                }
              />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </StepUpProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
