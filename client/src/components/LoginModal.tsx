import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { X, Mail, Lock, ArrowRight, Zap, MessageCircle } from 'lucide-react';

export default function LoginModal() {
  const { showLoginModal, closeLoginModal, login } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!showLoginModal) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      setEmail(''); setPassword(''); setError('');
      // 如果在首页或登录页，跳转到工作台
      if (location.pathname === '/' || location.pathname === '/login') {
        navigate('/app', { replace: true });
      }
    } catch (err: any) {
      setError(err.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    closeLoginModal();
    setError('');
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={handleClose} />

      {/* 弹窗 */}
      <div className="relative w-full max-w-md mx-4 bg-[#111] border border-white/10 rounded-2xl shadow-2xl shadow-black/50 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* 顶部渐变装饰 */}
        <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-blue-600/10 via-purple-600/5 to-transparent pointer-events-none" />

        {/* 关闭按钮 */}
        <button onClick={handleClose} className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors z-10">
          <X className="w-5 h-5" />
        </button>

        <div className="relative px-8 pt-8 pb-8">
          {/* Logo */}
          <div className="flex items-center gap-2.5 mb-6">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <Zap className="w-4.5 h-4.5 text-white" />
            </div>
            <span className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">
              短视频创意风暴
            </span>
          </div>

          <h2 className="text-xl font-bold text-white mb-1">欢迎回来</h2>
          <p className="text-zinc-500 text-sm mb-6">请使用已授权的账号登录</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5 uppercase tracking-wider">邮箱</label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="your@email.com" required autoFocus
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-10 pr-4 py-3 text-sm text-white focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all placeholder:text-zinc-600"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5 uppercase tracking-wider">密码</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="请输入密码" required minLength={6}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-10 pr-4 py-3 text-sm text-white focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all placeholder:text-zinc-600"
                />
              </div>
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5 text-sm text-red-400">
                {error}
              </div>
            )}

            <button
              type="submit" disabled={loading}
              className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-medium py-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>登录<ArrowRight className="w-4 h-4" /></>
              )}
            </button>
          </form>

          {/* 提示联系管理员 */}
          <div className="mt-5 text-center">
            <div className="flex items-center justify-center gap-1.5 text-zinc-500 text-sm">
              <MessageCircle className="w-3.5 h-3.5" />
              <span>没有账号？请联系管理员开通</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
