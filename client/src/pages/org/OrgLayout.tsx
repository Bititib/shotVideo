import React, { useEffect, useState, useCallback } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { Users, BarChart, FolderOpen, ArrowLeft, LogOut, Building2, Zap } from 'lucide-react';

const orgNavItems = [
  { to: '/org', icon: BarChart, label: '团队概览', end: true },
  { to: '/org/members', icon: Users, label: '成员管理' },
  { to: '/org/contents', icon: FolderOpen, label: '团队内容' },
];

export default function OrgLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex">
      {/* Sidebar */}
      <div className="w-60 shrink-0 bg-black border-r border-white/5 flex flex-col h-screen sticky top-0">
        <div className="p-5">
          <div className="flex items-center gap-2.5 mb-6">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-teal-500 to-cyan-600 flex items-center justify-center">
              <Building2 className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-white">{user?.org?.name || '团队管理'}</h1>
              <p className="text-[10px] text-zinc-500">{user?.email}</p>
            </div>
          </div>

          {/* 组织余额卡片 */}
          {user?.org && (
            <div className="mb-5 px-3 py-3 bg-gradient-to-br from-teal-500/10 to-cyan-500/5 border border-teal-500/15 rounded-xl">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400">组织余额</span>
                <span className="text-xs font-semibold text-teal-400">¥{(user.org.balance || 0).toFixed(2)}</span>
              </div>
            </div>
          )}

          <nav className="space-y-1">
            {orgNavItems.map(item => (
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
            <ArrowLeft className="w-3.5 h-3.5" /> 返回工作台
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
