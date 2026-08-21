import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { LayoutDashboard, Users, Star, Cpu, ArrowLeft, Zap, LogOut, Radio, Key, Coins, Building2, Film } from 'lucide-react';

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
    <div className="min-h-screen bg-[#0a0a0a] text-white flex">
      {/* Sidebar */}
      <div className="w-60 shrink-0 bg-black border-r border-white/5 flex flex-col h-screen sticky top-0">
        <div className="p-5">
          <div className="flex items-center gap-2.5 mb-6">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-white">管理后台</h1>
              <p className="text-[10px] text-zinc-500">{user?.email}</p>
            </div>
          </div>

          <nav className="space-y-1">
            {adminNavItems.map(item => (
              <NavLink key={item.to} to={item.to} end={item.end}
                className={({ isActive }) => `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${isActive ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'}`}>
                <item.icon className="w-4 h-4" />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="mt-auto p-5 space-y-2 border-t border-white/5">
          <button onClick={() => navigate('/app')} className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors w-full">
            <ArrowLeft className="w-3.5 h-3.5" /> 返回前台
          </button>
          <button onClick={() => { logout(); navigate('/login'); }} className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500 hover:text-red-400 transition-colors w-full">
            <LogOut className="w-3.5 h-3.5" /> 退出登录
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
