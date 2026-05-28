import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { getPublicSettings } from '../api/admin';
import { PlaySquare, ShoppingBag, Image as ImageIcon, Megaphone, Users, Shield, Zap, LogOut, LogIn, Crown, MessageCircle, Video, Building2 } from 'lucide-react';

const navItems = [
  { to: '/app', icon: PlaySquare, label: '通用分析', color: 'text-blue-400', feature: 'general' },
  { to: '/app/ecommerce', icon: ShoppingBag, label: '带货分析', color: 'text-purple-400', feature: 'ecommerce' },
  { to: '/app/image', icon: ImageIcon, label: '图片逆向', color: 'text-pink-400', feature: 'image' },
  { to: '/app/copywriting', icon: Megaphone, label: '电商文案', color: 'text-orange-400', feature: 'copywriting' },
  { to: '/app/account', icon: Users, label: '账号分析', color: 'text-emerald-400', feature: 'account' },
  { to: '/app/video', icon: Video, label: '视频生成', color: 'text-indigo-400', feature: 'video' },
  { to: '/app/image-gen', icon: ImageIcon, label: '图片生成', color: 'text-pink-400', feature: 'image_gen' },
];

const tierColors: Record<string, string> = {
  free: 'text-zinc-400',
  basic: 'text-yellow-400',
  pro: 'text-blue-400',
  enterprise: 'text-purple-400',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, logout, openLoginModal } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [contactInfo, setContactInfo] = useState<Record<string, string>>({});

  useEffect(() => { getPublicSettings().then(setContactInfo).catch(() => {}); }, []);

  const handleLogout = () => { logout(); navigate('/'); };

  const allowedFeatures = user?.tier?.allowedFeatures || [];
  const canAccess = (feature: string) => allowedFeatures.includes('*') || allowedFeatures.includes(feature) || user?.role === 'admin' || user?.role === 'super_admin';

  return (
    <div className="min-h-screen bg-black text-white font-sans flex flex-col md:flex-row">
      {/* Sidebar */}
      <div className="w-full md:w-64 shrink-0 bg-black flex flex-col md:h-screen sticky top-0 md:overflow-y-auto z-50 border-r border-white/5">
        <div className="p-4 md:p-6 flex flex-col gap-3 md:gap-6 h-full">
          <header className="flex-shrink-0 flex items-center justify-between md:block">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <Zap className="w-4 h-4 text-white" />
              </div>
              <h1 className="text-lg md:text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">
                短视频创意风暴
              </h1>
            </div>
          </header>

          <nav className="flex flex-row md:flex-col gap-1.5 flex-shrink-0 md:flex-1 overflow-x-auto overflow-y-hidden pb-1 md:pb-0 [&::-webkit-scrollbar]:hidden" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
            {navItems.map(item => {
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/app'}
                  className={({ isActive }) =>
                    `flex items-center gap-2 md:gap-3 px-3 py-2 md:px-4 md:py-3 rounded-lg md:rounded-xl text-xs md:text-sm font-medium transition-all shrink-0 md:w-full text-left group relative ${
                      isActive
                        ? 'bg-white/10 text-white'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
                    }`
                  }
                >
                  <item.icon className={`w-4 h-4 md:w-5 md:h-5 shrink-0 ${location.pathname === item.to || (item.to !== '/app' && location.pathname.startsWith(item.to)) ? item.color : ''}`} />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </nav>

          {/* 计费提示 */}
          <div className="hidden md:block px-3 py-2.5 mx-1 bg-gradient-to-br from-emerald-500/10 via-blue-500/5 to-purple-500/10 border border-emerald-500/15 rounded-xl">
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span className="text-[10px] font-semibold text-emerald-400">生成成功才扣费，失败不计费</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] text-zinc-500">
              <span>📹 视频 480p</span><span className="text-right text-zinc-400">¥{contactInfo.video_rate_480p || '0.03'}/秒</span>
              <span>📹 视频 720p</span><span className="text-right text-zinc-400">¥{contactInfo.video_rate_720p || '0.05'}/秒</span>
              <span>🎨 图片生成</span><span className="text-right text-zinc-400">¥{contactInfo.image_rate || '0.05'}/张</span>
            </div>
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

            {/* 联系客服 */}
            {(contactInfo.contact_wechat || contactInfo.contact_qq) && (
              <div className="px-4 py-3 bg-gradient-to-r from-blue-500/5 to-purple-500/5 border border-white/5 rounded-xl">
                <div className="flex items-center gap-1.5 mb-2">
                  <MessageCircle className="w-3.5 h-3.5 text-blue-400" />
                  <span className="text-[10px] font-medium text-zinc-300">联系客服 · 升级会员</span>
                </div>
                {contactInfo.contact_wechat && (
                  <div className="flex items-center justify-between text-[10px] mb-1">
                    <span className="text-zinc-500">微信</span>
                    <span className="text-zinc-300 font-mono select-all">{contactInfo.contact_wechat}</span>
                  </div>
                )}
                {contactInfo.contact_qq && (
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-zinc-500">QQ</span>
                    <span className="text-zinc-300 font-mono select-all">{contactInfo.contact_qq}</span>
                  </div>
                )}
              </div>
            )}

            {isAuthenticated ? (
              <>
                <div className="px-4 py-3 bg-white/[0.02] rounded-xl">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-zinc-400">{user?.username || user?.email}</span>
                    <span className={`text-xs font-medium ${tierColors[user?.tier?.name || 'free']}`}>
                      {user?.tier?.displayName || '免费用户'}
                    </span>
                  </div>
                  {user?.tier && user.tier.dailyQuota !== -1 && (
                    <div className="mt-2">
                      <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
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
                </div>
                <button onClick={handleLogout} className="flex items-center gap-2 px-4 py-2 text-xs text-zinc-500 hover:text-red-400 transition-colors">
                  <LogOut className="w-3.5 h-3.5" />
                  退出登录
                </button>
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
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-h-screen md:h-screen md:overflow-hidden bg-[#0c0c0c] relative">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-white/[0.01] via-transparent to-transparent pointer-events-none" />
        <div className="relative z-10 flex-1 md:overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
