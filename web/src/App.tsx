import { Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';

import { AppLayout } from '@/components/layout/AppLayout';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth';
import { CompaniesPage } from '@/pages/CompaniesPage';
import { CompanyDetailPage } from '@/pages/CompanyDetailPage';
import { CrmPage } from '@/pages/CrmPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { EmailStudioPage } from '@/pages/EmailStudioPage';
import { LeadDiscoveryPage } from '@/pages/LeadDiscoveryPage';
import { LoginPage } from '@/pages/LoginPage';
import { SettingsPage } from '@/pages/SettingsPage';

function RequireAuth() {
  const token = useAuthStore((s) => s.token);
  return token ? <Outlet /> : <Navigate to="/login" replace />;
}

function TopBarUser() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  if (!user) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{user.email}</span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="退出登录"
        onClick={() => {
          logout();
          navigate('/login', { replace: true });
        }}
      >
        <LogOut className="size-4" />
      </Button>
    </div>
  );
}

export default function App() {
  return (
    <RouteErrorBoundary>
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout userSlot={<TopBarUser />} />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/lead-discovery" element={<LeadDiscoveryPage />} />
          <Route path="/companies" element={<CompaniesPage />} />
          <Route path="/companies/:id" element={<CompanyDetailPage />} />
          <Route path="/crm" element={<CrmPage />} />
          <Route path="/email-studio" element={<EmailStudioPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </RouteErrorBoundary>
  );
}
