import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { getPublicSettings } from '../api/admin';
import { PlaySquare, ShoppingBag, Image as ImageIcon, Megaphone, Users, Shield, Layers3, LogOut, LogIn, Crown, MessageCircle, Video, Building2, Volume2, X, Key, User, FileText, History } from 'lucide-react';

const navItems: Array<{ to: string; icon: typeof PlaySquare; label: string; color: string; feature: string; requiresApiKey?: boolean }> = [
  { to: '/app', icon: PlaySquare, label: '通用分析', color: 'text-blue-400', feature: 'general' },
  { to: '/app/ecommerce', icon: ShoppingBag, label: '带货分析', color: 'text-purple-400', feature: 'ecommerce' },
  { to: '/app/image', icon: ImageIcon, label: '图片逆向', color: 'text-pink-400', feature: 'image' },
  { to: '/app/copywriting', icon: Megaphone, label: '电商文案', color: 'text-orange-400', feature: 'copywriting' },
  { to: '/app/account', icon: Users, label: '账号分析', color: 'text-emerald-400', feature: 'account' },
  { to: '/app/video', icon: Video, label: '视频生成', color: 'text-indigo-400', feature: 'video' },
  { to: '/app/image-gen', icon: ImageIcon, label: '图片生成', color: 'text-pink-400', feature: 'image_gen' },
  { to: '/app/tts', icon: Volume2, label: '语音合成', color: 'text-yellow-400', feature: 'tts' },
  { to: '/app/history', icon: History, label: '生成记录', color: 'text-amber-400', feature: 'history', requiresApiKey: true },
  { to: '/app/docs', icon: FileText, label: '接口文档', color: 'text-rose-400', feature: 'docs' },
];

const tierColors: Record<string, string> = {
  free: 'text-zinc-400',
  basic: 'text-yellow-400',
  pro: 'text-blue-400',
  enterprise: 'text-purple-400',
};

export default function Layout({ children }: { children?: React.ReactNode }) {
  const { user, isAuthenticated, logout, openLoginModal } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [contactInfo, setContactInfo] = useState<Record<string, string>>({});
  const [showContact, setShowContact] = useState(() => localStorage.getItem('hide_contact') !== 'true');

  const [showChangePassword, setShowChangePassword] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [cpError, setCpError] = useState<string | null>(null);
  const [cpSuccess, setCpSuccess] = useState<string | null>(null);
  const [cpLoading, setCpLoading] = useState(false);

  useEffect(() => { getPublicSettings().then(setContactInfo).catch(() => { }); }, []);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oldPassword || !newPassword || !confirmPassword) {
      setCpError('所有字段均为必填项');
      return;
    }
    if (newPassword.length < 6) {
      setCpError('新密码必须至少6位');
      return;
    }
    if (newPassword !== confirmPassword) {
      setCpError('两次输入的新密码不一致');
      return;
    }

    setCpError(null);
    setCpSuccess(null);
    setCpLoading(true);

    try {
      const { authApi } = await import('../api/auth');
      await authApi.changePassword(oldPassword, newPassword);
      setCpSuccess('密码修改成功，请妥善保管新密码');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => {
        setShowChangePassword(false);
        setCpSuccess(null);
      }, 2000);
    } catch (err: any) {
      setCpError(err.message || '密码修改失败，请重试');
    } finally {
      setCpLoading(false);
    }
  };

  const handleLogout = () => { logout(); navigate('/'); };

  const allowedFeatures = user?.tier?.allowedFeatures || [];
  const canAccess = (feature: string) => allowedFeatures.includes('*') || allowedFeatures.includes(feature) || user?.role === 'admin' || user?.role === 'super_admin';

  return (
    <div className="earth-app-shell min-h-screen bg-black text-white font-sans flex flex-col md:flex-row">
      {/* Sidebar */}
      <aside className="earth-sidebar w-full md:w-64 shrink-0 bg-black flex flex-col md:h-screen sticky top-0 z-50 border-r border-white/5 md:overflow-hidden" aria-label="主导航">
        <div className="p-4 md:p-6 flex flex-col gap-3 md:gap-6 h-full">
          <header className="flex-shrink-0 flex items-center justify-between md:block">
            <div className="earth-brand flex items-center gap-3">
              <div className="earth-brand-mark w-9 h-9 rounded-xl flex items-center justify-center" aria-hidden="true">
                <Layers3 className="w-[18px] h-[18px]" strokeWidth={1.8} />
              </div>
              <div className="min-w-0">
                <h1 className="earth-brand-name text-base md:text-lg font-bold whitespace-nowrap">短视频创意风暴</h1>
                <p className="earth-brand-subtitle hidden md:block">AI CREATIVE STUDIO</p>
              </div>
            </div>
          </header>

          <nav className="flex flex-row md:flex-col gap-1.5 flex-shrink-0 md:flex-1 overflow-x-auto overflow-y-hidden md:overflow-y-auto pb-1 md:pb-0 [&::-webkit-scrollbar]:hidden" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
            {navItems.filter(item => !item.requiresApiKey || user?.hasActiveApiKey).map(item => {
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/app'}
                  className={({ isActive }) =>
                    `flex items-center gap-2 md:gap-3 px-3 py-2 md:px-4 md:py-3 rounded-lg md:rounded-xl text-xs md:text-sm font-medium transition-all shrink-0 md:w-full text-left group relative ${isActive
                      ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                      : 'text-zinc-400 hover:text-amber-200 hover:bg-amber-500/5'
                    }`
                  }
                >
                  <item.icon className={`w-4 h-4 md:w-5 md:h-5 shrink-0 ${location.pathname === item.to || (item.to !== '/app' && location.pathname.startsWith(item.to)) ? item.color : ''}`} />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </nav>

          {/* 联系客服 悬浮开关 */}
          <div className="hidden md:flex flex-col gap-1 px-4 text-zinc-500 text-[10px] mt-2 border-t border-white/5 pt-2">
            <button
              onClick={() => { setShowContact(!showContact); if (showContact) { localStorage.setItem('hide_contact', 'true'); } else { localStorage.removeItem('hide_contact'); } }}
              className="flex items-center gap-1.5 hover:text-zinc-300 transition-colors text-left py-1 cursor-pointer"
            >
              <MessageCircle className={`w-3.5 h-3.5 ${showContact ? 'text-blue-400' : 'text-zinc-500'}`} />
              <span>联系客服 {showContact ? '(已开启)' : '(点击开启悬浮)'}</span>
            </button>
          </div>

          {/* User Info */}
          <div className="hidden md:flex flex-col gap-3 pt-4 border-t border-white/5 mt-auto">
            {isAuthenticated && (user?.role === 'admin' || user?.role === 'super_admin') && (
              <NavLink to="/admin" className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-amber-400 hover:bg-amber-500/10 transition-all">
                <Shield className="w-4 h-4" />
                管理后台
              </NavLink>
            )}

            {isAuthenticated && user?.org && (user?.role === 'org_owner' || user?.role === 'org_admin') && (
              <NavLink to="/org" className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-teal-400 hover:bg-teal-500/10 transition-all">
                <Building2 className="w-4 h-4" />
                团队管理
              </NavLink>
            )}

            {/* 联系客服已从静态列表移出，改用悬浮组件 */}

            {isAuthenticated ? (
              <>
                <NavLink to="/app/profile" className="block px-4 py-3 bg-white/[0.02] hover:bg-white/[0.04] rounded-xl border border-transparent hover:border-white/5 transition-all group">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-zinc-400 group-hover:text-white transition-colors">{user?.username || user?.email}</span>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded bg-white/5 ${tierColors[user?.tier?.name || 'free']}`}>
                      {user?.tier?.displayName || '免费用户'}
                    </span>
                  </div>
                  {user?.tier && user.tier.dailyQuota !== -1 && (
                    <div className="mt-2">
                      <div className="flex justify-between text-[9px] text-zinc-500 mb-1">
                        <span>今日用量</span>
                        <span>{user.usedToday} / {user.tier.dailyQuota}</span>
                      </div>
                      <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all"
                          style={{ width: `${Math.min(100, (user.usedToday / user.tier.dailyQuota) * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {/* 账户余额 */}
                  <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-white/5 text-[9px]">
                    <span className="text-zinc-500">账户余额</span>
                    <span className="font-bold text-emerald-400">¥{user?.balance?.toFixed(2) ?? '0.00'}</span>
                  </div>
                </NavLink>
                <div className="flex items-center justify-between px-4 py-2">
                  <NavLink to="/app/profile" className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
                    <User className="w-3.5 h-3.5" />
                    个人中心
                  </NavLink>
                  <button onClick={handleLogout} className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-red-400 transition-colors">
                    <LogOut className="w-3.5 h-3.5" />
                    退出登录
                  </button>
                </div>
              </>
            ) : (
              <button
                onClick={openLoginModal}
                className="flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 rounded-xl text-sm font-medium text-white transition-all shadow-lg shadow-blue-500/10"
              >
                <LogIn className="w-4 h-4" />
                登录
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="earth-workspace flex-1 flex flex-col min-h-screen md:h-screen md:overflow-hidden bg-[#0c0c0c] relative" id="main-content">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-white/[0.01] via-transparent to-transparent pointer-events-none" />
        <div className="relative z-10 flex-1 md:overflow-y-auto">{children ?? <Outlet />}</div>
      </main>

      {/* 悬浮客服面板 */}
      {showContact && (contactInfo.contact_wechat || contactInfo.contact_qq) && (
        <div className="fixed bottom-6 right-6 z-[999] flex flex-col gap-3 items-end pointer-events-none hidden md:flex">
          <div className="pointer-events-auto w-72 bg-zinc-950/95 border border-zinc-800 rounded-2xl p-4 shadow-2xl backdrop-blur-md relative text-zinc-100 flex flex-col gap-2.5 transition-all duration-300">
            <button
              onClick={() => { setShowContact(false); localStorage.setItem('hide_contact', 'true'); }}
              className="absolute top-3.5 right-3.5 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-1.5">
              <MessageCircle className="w-4 h-4 text-blue-400" />
              <span className="text-xs font-semibold text-zinc-100">联系客服 · 升级会员</span>
            </div>
            <div className="flex flex-col gap-2 border-t border-zinc-900 pt-2.5 text-xs text-zinc-400">
              {contactInfo.contact_wechat && (
                <div className="flex items-center justify-between">
                  <span>微信</span>
                  <span className="text-zinc-200 font-mono select-all bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800/50">{contactInfo.contact_wechat}</span>
                </div>
              )}
              {contactInfo.contact_qq && (
                <div className="flex items-center justify-between">
                  <span>QQ</span>
                  <span className="text-zinc-200 font-mono select-all bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800/50">{contactInfo.contact_qq}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 修改密码模态框 */}
      {showChangePassword && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/65 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm bg-[#121212] border border-white/10 rounded-2xl p-6 shadow-2xl relative">
            <button onClick={() => { setShowChangePassword(false); setCpError(null); setCpSuccess(null); }} className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-300 transition-colors">
              <X className="w-4 h-4" />
            </button>
            <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <Key className="w-4 h-4 text-indigo-400" /> 修改登录密码
            </h3>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">当前密码</label>
                <input type="password" value={oldPassword} onChange={e => setOldPassword(e.target.value)} required className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-indigo-500/50 transition-colors" />
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">新密码（至少6位）</label>
                <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-indigo-500/50 transition-colors" />
              </div>
              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">确认新密码</label>
                <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-indigo-500/50 transition-colors" />
              </div>

              {cpError && <p className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/10 rounded-lg p-2.5">{cpError}</p>}
              {cpSuccess && <p className="text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/10 rounded-lg p-2.5">{cpSuccess}</p>}

              <button type="submit" disabled={cpLoading} className="w-full py-2.5 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-xs font-medium text-white rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                {cpLoading ? '保存中...' : '保存密码'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
