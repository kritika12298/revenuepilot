import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth/AuthProvider.jsx';
import { AppShell } from './layout/AppShell.jsx';
import { Spinner, EmptyState, ErrorState } from './components/ui/States.jsx';
import { LoginPage, RegisterPage } from './pages/AuthPages.jsx';
import { Compass } from 'lucide-react';

// Pages load on demand (smaller first load; the public enquiry form ships as its own small chunk).
const OverviewPage = lazy(() => import('./pages/OverviewPage.jsx').then((m) => ({ default: m.OverviewPage })));
const LeadsPage = lazy(() => import('./pages/LeadsPage.jsx').then((m) => ({ default: m.LeadsPage })));
const LeadDetailPage = lazy(() => import('./pages/LeadDetailPage.jsx').then((m) => ({ default: m.LeadDetailPage })));
const ConversationsPage = lazy(() => import('./pages/ConversationsPage.jsx').then((m) => ({ default: m.ConversationsPage })));
const FollowUpsPage = lazy(() => import('./pages/FollowUpsPage.jsx').then((m) => ({ default: m.FollowUpsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx').then((m) => ({ default: m.SettingsPage })));
const AiActivityPage = lazy(() => import('./pages/AiActivityPage.jsx').then((m) => ({ default: m.AiActivityPage })));
const KnowledgePage = lazy(() => import('./pages/KnowledgePage.jsx').then((m) => ({ default: m.KnowledgePage })));
const AutonomyPage = lazy(() => import('./pages/AutonomyPage.jsx').then((m) => ({ default: m.AutonomyPage })));
const PublicFormPage = lazy(() => import('./pages/PublicFormPage.jsx').then((m) => ({ default: m.PublicFormPage })));
const RevenuePage = lazy(() => import('./pages/RevenuePage.jsx').then((m) => ({ default: m.RevenuePage })));
const SimulatorPage = lazy(() => import('./pages/SimulatorPage.jsx').then((m) => ({ default: m.SimulatorPage })));
const IntegrationsPage = lazy(() => import('./pages/IntegrationsPage.jsx').then((m) => ({ default: m.IntegrationsPage })));
import { Link } from 'react-router';

function RequireAuth({ children }) {
  const { token, session, loading, sessionError, retrySession } = useAuth();
  const location = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: location }} />;
  if (sessionError) return <ErrorState error={sessionError} onRetry={retrySession} title="Can't reach RevenuePilot right now" className="h-full" />;
  if (loading || !session) {
    return (
      <div className="flex h-full items-center justify-center text-muted" role="status" aria-label="Loading">
        <Spinner />
      </div>
    );
  }
  return children;
}

function NotFound() {
  return (
    <EmptyState
      icon={Compass}
      title="Page not found"
      description="That page doesn't exist."
      action={
        <Link to="/" className="text-sm font-medium text-accent hover:underline">
          Back to overview
        </Link>
      }
    />
  );
}

function PageLoading() {
  return (
    <div className="flex min-h-64 items-center justify-center text-muted" role="status" aria-label="Loading page">
      <Spinner />
    </div>
  );
}

export function App() {
  return (
    <Suspense fallback={<PageLoading />}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/f/:slug" element={<PublicFormPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="leads/:id" element={<LeadDetailPage />} />
        <Route path="conversations" element={<ConversationsPage />} />
        <Route path="conversations/:leadId" element={<ConversationsPage />} />
        <Route path="follow-ups" element={<FollowUpsPage />} />
        <Route path="ai-activity" element={<AiActivityPage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="autonomy" element={<AutonomyPage />} />
        <Route path="revenue" element={<RevenuePage />} />
        <Route path="simulator" element={<SimulatorPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
    </Suspense>
  );
}
