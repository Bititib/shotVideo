import { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { ProtectedRoute, AdminRoute, OrgAdminRoute } from './components/ProtectedRoute';
import { useAuthStore } from './stores/authStore';
import Layout from './components/Layout';
import LoginModal from './components/LoginModal';
import LandingPage from './pages/LandingPage';
import GeneralPage from './pages/analysis/GeneralPage';
import EcommercePage from './pages/analysis/EcommercePage';
import ImagePage from './pages/analysis/ImagePage';
import CopywritingPage from './pages/analysis/CopywritingPage';
import AccountPage from './pages/analysis/AccountPage';
import VideoPage from './pages/analysis/VideoPage';
import VideoStudioPage from './pages/analysis/VideoStudioPage';
import ImageGenPage from './pages/analysis/ImageGenPage';
import TtsPage from './pages/analysis/TtsPage';
import ProfilePage from './pages/analysis/ProfilePage';
import AdminLayout from './pages/admin/AdminLayout';
import DashboardPage from './pages/admin/DashboardPage';
import UsersPage from './pages/admin/UsersPage';
import TiersPage from './pages/admin/TiersPage';
import ModelsPage from './pages/admin/ModelsPage';
import ChannelsPage from './pages/admin/ChannelsPage';
import TokensPage from './pages/admin/TokensPage';
import PricingPage from './pages/admin/PricingPage';
import OrgsPage from './pages/admin/OrgsPage';
import OrgLayout from './pages/org/OrgLayout';
import OrgDashboard from './pages/org/OrgDashboard';
import OrgMembersPage from './pages/org/OrgMembersPage';
import OrgContentsPage from './pages/org/OrgContentsPage';

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
    </>
  );
}

