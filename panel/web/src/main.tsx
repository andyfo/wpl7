import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { ResetPassword } from './pages/ResetPassword';
import { ConfirmEmail } from './pages/ConfirmEmail';
import { Dashboard } from './pages/Dashboard';
import { Sites } from './pages/Sites';
import { Servers } from './pages/Servers';
import { ServerDetail } from './pages/ServerDetail';
import { NewSite } from './pages/NewSite';
import { BulkManagement } from './pages/BulkManagement';
import { SitesSecurity } from './pages/SitesSecurity';
import { ServersSecurity } from './pages/ServersSecurity';
import { SiteDetail } from './pages/SiteDetail';
import { Plugins } from './pages/Plugins';
import { Recipes } from './pages/Recipes';
import { Backups } from './pages/Backups';
import { BackupStorage } from './pages/BackupStorage';
import { Jobs } from './pages/Jobs';
import { JobDetail } from './pages/JobDetail';
import { Schedules } from './pages/Schedules';
import { ApiKeys } from './pages/ApiKeys';
import { Mcp } from './pages/Mcp';
import { OAuthAuthorize } from './pages/OAuthAuthorize';
import { Users } from './pages/Users';
import { UserDetail } from './pages/UserDetail';
import { Settings } from './pages/Settings';
import { Terminal } from './pages/Terminal';
import { Mail } from './pages/Mail';
import { About } from './pages/About';
import { Support } from './pages/Support';
import { WpGodmode } from './pages/WpGodmode';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5000, retry: 1, refetchOnWindowFocus: false } },
});

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  // What the emailed links open. Outside the layout, like the sign-in page: the browser that
  // follows one is often not signed in to anything.
  { path: '/reset-password', element: <ResetPassword /> },
  { path: '/confirm-email', element: <ConfirmEmail /> },
  // Where an AI app sends its admin to approve it. Outside the layout for the same reason: the
  // browser arriving from the app's site is not signed in yet as far as the panel can tell.
  { path: '/oauth/authorize', element: <OAuthAuthorize /> },
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'sites', element: <Sites /> },
      { path: 'servers', element: <Servers /> },
      // Before 'servers/:id', like 'sites/security' before 'sites/:slug'.
      { path: 'servers/security', element: <ServersSecurity /> },
      { path: 'servers/:id', element: <ServerDetail /> },
      { path: 'servers/:id/terminal', element: <Terminal /> },
      // The nav link: resolves to the server used last and redirects to its own URL, so a
      // root shell is never open at an address that does not name the machine.
      { path: 'terminal', element: <Terminal /> },
      { path: 'sites/new', element: <NewSite /> },
      // A static segment outranks ':slug' in react-router, and "bulk" is refused for new
      // sites - so only a site created before that reservation can be shadowed here, and it
      // stays reachable everywhere else (see siteSlugParam in shared/schemas.ts).
      { path: 'sites/bulk', element: <BulkManagement /> },
      // Reserved like "bulk" (RESERVED_SLUGS), for the same reason.
      { path: 'sites/security', element: <SitesSecurity /> },
      { path: 'sites/:slug', element: <SiteDetail /> },
      { path: 'plugins', element: <Plugins /> },
      { path: 'plugins/recipes', element: <Recipes /> },
      { path: 'backups', element: <Backups /> },
      { path: 'backups/storage', element: <BackupStorage /> },
      { path: 'mail', element: <Mail /> },
      { path: 'jobs', element: <Jobs /> },
      // Declared before 'jobs/:id', like 'sites/bulk' before 'sites/:slug'; a job id is a
      // number, so nothing is shadowed.
      { path: 'jobs/schedules', element: <Schedules /> },
      { path: 'jobs/:id', element: <JobDetail /> },
      { path: 'api-keys', element: <ApiKeys /> },
      // Not /mcp: that is the MCP endpoint itself.
      { path: 'integrations/mcp', element: <Mcp /> },
      { path: 'users', element: <Users /> },
      { path: 'users/:id', element: <UserDetail /> },
      { path: 'settings', element: <Settings /> },
      { path: 'about', element: <About /> },
      { path: 'support', element: <Support /> },
      { path: 'wp-godmode', element: <WpGodmode /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
