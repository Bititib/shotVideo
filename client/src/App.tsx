import { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { ProtectedRoute, AdminRoute } from './components/ProtectedRoute';
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
import AdminLayout from './pages/admin/AdminLayout';
import DashboardPage from './pages/admin/DashboardPage';
import UsersPage from './pages/admin/UsersPage';
import TiersPage from './pages/admin/TiersPage';
import ModelsPage from './pages/admin/ModelsPage';
import ChannelsPage from './pages/admin/ChannelsPage';
import TokensPage from './pages/admin/TokensPage';
import PricingPage from './pages/admin/PricingPage';

/** /login 路由 → 重定向到首页并弹出登录弹窗 */
function LoginRedirect() {
  const navigate = useNavigate();
  const { openLoginModal, isAuthenticated } = useAuthStore();
  useEffect(() => {
    if (isAuthenticated) {
      navigate('/app', { replace: true });
    } else {
      openLoginModal();
      navigate('/', { replace: true });
    }
  }, []);
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

        {/* Admin — 仍需登录+管理员权限 */}
        <Route path="/admin" element={<AdminRoute><AdminLayout /></AdminRoute>}>
          <Route index element={<DashboardPage />} />
          <Route path="channels" element={<ChannelsPage />} />
          <Route path="tokens" element={<TokensPage />} />
          <Route path="pricing" element={<PricingPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="tiers" element={<TiersPage />} />
          <Route path="models" element={<ModelsPage />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
