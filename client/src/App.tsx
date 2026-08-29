import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { ProtectedRoute, ApiKeyRoute, AdminRoute, OrgAdminRoute } from './components/ProtectedRoute';
import { useAuthStore } from './stores/authStore';
import Layout from './components/Layout';
import LoginModal from './components/LoginModal';

// Keep the shell small: each page is downloaded only when its route is opened.
const LandingPage = lazy(() => import('./pages/LandingPage'));
const GeneralPage = lazy(() => import('./pages/analysis/GeneralPage'));
const EcommercePage = lazy(() => import('./pages/analysis/EcommercePage'));
const ImagePage = lazy(() => import('./pages/analysis/ImagePage'));
const CopywritingPage = lazy(() => import('./pages/analysis/CopywritingPage'));
const AccountPage = lazy(() => import('./pages/analysis/AccountPage'));
const VideoPage = lazy(() => import('./pages/analysis/VideoPage'));
const VideoStudioPage = lazy(() => import('./pages/analysis/VideoStudioPage'));
const ImageGenPage = lazy(() => import('./pages/analysis/ImageGenPage'));
const TtsPage = lazy(() => import('./pages/analysis/TtsPage'));
const HistoryPage = lazy(() => import('./pages/analysis/HistoryPage'));
const ProfilePage = lazy(() => import('./pages/analysis/ProfilePage'));
const DocsPage = lazy(() => import('./pages/DocsPage'));
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const DashboardPage = lazy(() => import('./pages/admin/DashboardPage'));
const UsersPage = lazy(() => import('./pages/admin/UsersPage'));
const TiersPage = lazy(() => import('./pages/admin/TiersPage'));
const ModelsPage = lazy(() => import('./pages/admin/ModelsPage'));
const ChannelsPage = lazy(() => import('./pages/admin/ChannelsPage'));
const TokensPage = lazy(() => import('./pages/admin/TokensPage'));
const PricingPage = lazy(() => import('./pages/admin/PricingPage'));
const OrgsPage = lazy(() => import('./pages/admin/OrgsPage'));
const ContentsPage = lazy(() => import('./pages/admin/ContentsPage'));
const FeedbackPage = lazy(() => import('./pages/admin/FeedbackPage'));
const OrgLayout = lazy(() => import('./pages/org/OrgLayout'));
const OrgDashboard = lazy(() => import('./pages/org/OrgDashboard'));
const OrgMembersPage = lazy(() => import('./pages/org/OrgMembersPage'));
const OrgContentsPage = lazy(() => import('./pages/org/OrgContentsPage'));

function PageLoading() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center" role="status" aria-live="polite">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-indigo-500" />
      <span className="sr-only">页面加载中</span>
    </div>
  );
}

/** /login 路由 → 已登录跳工作台，未登录弹登录框 */
function LoginRedirect() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading, openLoginModal } = useAuthStore();

  useEffect(() => {
    if (isLoading) return; // 等 checkAuth 完成
    if (isAuthenticated) {
      navigate('/app', { replace: true });
    } else {
      openLoginModal();
      navigate('/app', { replace: true });
    }
  }, [isLoading, isAuthenticated]);

  return null;
}

export default function App() {
  const { checkAuth } = useAuthStore();

  useEffect(() => { checkAuth(); }, []);

  return (
    <>
      {/* 全局登录弹窗 */}
      <LoginModal />

      <Suspense fallback={<PageLoading />}>
      <Routes>
        {/* Public */}
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginRedirect />} />

        {/* 工作台 — 可自由浏览，操作时弹窗登录 */}
        <Route path="/app" element={<Layout><GeneralPage /></Layout>} />
        <Route path="/app/ecommerce" element={<Layout><EcommercePage /></Layout>} />
        <Route path="/app/image" element={<Layout><ImagePage /></Layout>} />
        <Route path="/app/copywriting" element={<Layout><CopywritingPage /></Layout>} />
        <Route path="/app/account" element={<Layout><AccountPage /></Layout>} />
        <Route path="/app/video" element={<Layout><VideoPage /></Layout>} />
        <Route path="/app/video/studio" element={<VideoStudioPage />} />
        <Route path="/app/image-gen" element={<Layout><ImageGenPage /></Layout>} />
        <Route path="/app/tts" element={<Layout><TtsPage /></Layout>} />
        <Route path="/app/history" element={<ApiKeyRoute><Layout><HistoryPage /></Layout></ApiKeyRoute>} />
        <Route path="/app/docs" element={<Layout><DocsPage /></Layout>} />
        <Route path="/app/profile" element={<ProtectedRoute><Layout><ProfilePage /></Layout></ProtectedRoute>} />

        {/* Admin — 仍需登录+超级管理员权限 */}
        <Route path="/admin" element={<AdminRoute><AdminLayout /></AdminRoute>}>
          <Route index element={<DashboardPage />} />
          <Route path="channels" element={<ChannelsPage />} />
          <Route path="tokens" element={<TokensPage />} />
          <Route path="pricing" element={<PricingPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="tiers" element={<TiersPage />} />
          <Route path="models" element={<ModelsPage />} />
          <Route path="orgs" element={<OrgsPage />} />
          <Route path="contents" element={<ContentsPage />} />
          <Route path="feedback" element={<FeedbackPage />} />
        </Route>

        {/* Org — 组织管理员面板 */}
        <Route path="/org" element={<OrgAdminRoute><OrgLayout /></OrgAdminRoute>}>
          <Route index element={<OrgDashboard />} />
          <Route path="members" element={<OrgMembersPage />} />
          <Route path="contents" element={<OrgContentsPage />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </>
  );
}
