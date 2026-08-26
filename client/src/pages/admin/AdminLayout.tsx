import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { LayoutDashboard, Users, Star, Cpu, ArrowLeft, Layers3, LogOut, Radio, Key, Coins, Building2, Film } from 'lucide-react';

const adminNavItems = [
  { to: '/admin', icon: LayoutDashboard, label: '仪表盘', end: true },
  { to: '/admin/channels', icon: Radio, label: '渠道管理' },
  { to: '/admin/tokens', icon: Key, label: 'Token 管理' },
  { to: '/admin/pricing', icon: Coins, label: '计费设置' },
  { to: '/admin/users', icon: Users, label: '用户管理' },
  { to: '/admin/tiers', icon: Star, label: '等级配置' },
  { to: '/admin/models', icon: Cpu, label: '模型管理' },
  { to: '/admin/orgs', icon: Building2, label: '组织管理' },
  { to: '/admin/contents', icon: Film, label: '内容管理' },
];

export default function AdminLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  return (
    <div className="admin-shell min-h-screen flex flex-col md:flex-row">
      {/* Sidebar */}
      <aside className="admin-sidebar w-full md:w-60 shrink-0 flex flex-col md:h-screen sticky top-0 z-40">
        <div className="p-4 md:p-5 flex-1 min-h-0">
          <div className="flex items-center gap-3 mb-4 md:mb-7">
            <div className="admin-brand-mark w-9 h-9 rounded-xl flex items-center justify-center" aria-hidden="true">
              <Layers3 className="w-[18px] h-[18px]" strokeWidth={1.8} />
            </div>
            <div className="min-w-0">
              <h1 className="admin-brand-title text-sm font-bold">管理后台</h1>
              <p className="admin-brand-subtitle text-[10px] truncate">{user?.email}</p>
            </div>
          </div>

          <nav className="admin-nav flex md:block gap-1.5 md:space-y-1 overflow-x-auto md:overflow-y-auto pb-1 md:pb-0" aria-label="管理员导航">
            {adminNavItems.map(item => (
              <NavLink key={item.to} to={item.to} end={item.end}
                className={({ isActive }) => `admin-nav-link flex items-center gap-2.5 md:gap-3 px-3 py-2.5 rounded-xl text-xs md:text-sm font-medium whitespace-nowrap shrink-0 ${isActive ? 'is-active' : ''}`}>
                <item.icon className="w-4 h-4" />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="admin-sidebar-footer hidden md:block mt-auto p-5 space-y-2 border-t">
          <button onClick={() => navigate('/app')} className="admin-quiet-action flex items-center gap-2 px-3 py-2 text-xs w-full rounded-lg">
            <ArrowLeft className="w-3.5 h-3.5" /> 返回前台
          </button>
          <button onClick={() => { logout(); navigate('/login'); }} className="admin-quiet-action is-danger flex items-center gap-2 px-3 py-2 text-xs w-full rounded-lg">
            <LogOut className="w-3.5 h-3.5" /> 退出登录
          </button>
        </div>
      </aside>

      {/* Content */}
      <main className="admin-content flex-1 min-w-0 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
