import BrandMark from './BrandMark';
import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { X, Mail, Lock, ArrowRight, User, Eye, EyeOff } from 'lucide-react';

export default function LoginModal() {
  const { showLoginModal, closeLoginModal, login, register } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleClose = () => {
    closeLoginModal();
    setPassword('');
    setConfirmPassword('');
    setIsRegister(false);
    setShowPassword(false);
    setError('');
  };

  useEffect(() => {
    if (!showLoginModal) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showLoginModal]);

  if (!showLoginModal) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (isRegister && password !== confirmPassword) { setError('两次输入的密码不一致'); return; }
    setLoading(true);
    try {
      if (isRegister) await register(email, username, password);
      else await login(email, password);
      setEmail(''); setPassword(''); setConfirmPassword(''); setUsername(''); setIsRegister(false); setError('');
      // 如果在首页或登录页，跳转到工作台
      if (location.pathname === '/' || location.pathname === '/login') {
        navigate('/app', { replace: true });
      }
    } catch (err: any) {
      setError(err.message || (isRegister ? '注册失败' : '登录失败'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-modal fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
      {/* 遮罩 */}
      <div className="login-modal-backdrop absolute inset-0" onClick={handleClose} aria-hidden="true" />

      {/* 弹窗 */}
      <section
        className="login-modal-card relative w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto animate-in fade-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-modal-title"
        aria-describedby="login-modal-description"
      >
        <div className="login-modal-decor absolute inset-x-0 top-0 h-36 pointer-events-none" aria-hidden="true" />

        {/* 关闭按钮 */}
        <button onClick={handleClose} className="login-modal-close absolute top-4 right-4 z-10" aria-label="关闭登录窗口">
          <X className="w-[18px] h-[18px]" />
        </button>

        <div className="relative px-6 py-7 sm:px-8 sm:py-8">
          {/* Logo */}
          <div className="flex items-center gap-3 mb-7 pr-10">
            <div className="login-modal-brand-mark w-10 h-10 rounded-xl flex items-center justify-center" aria-hidden="true">
              <BrandMark size={40} />
            </div>
            <span className="login-modal-brand-name text-lg font-bold">
              灵序 AI
            </span>
          </div>

          <h2 id="login-modal-title" className="login-modal-title text-2xl font-bold mb-1.5">{isRegister ? '创建账号' : '欢迎回来'}</h2>
          <p id="login-modal-description" className="login-modal-subtitle text-sm mb-7">{isRegister ? '填写邮箱和密码，注册后即可登录工作台' : '登录账号，进入创作工作台'}</p>

          <form onSubmit={handleSubmit} className="space-y-5">
            {isRegister && <div><label htmlFor="register-username" className="login-modal-label block text-sm font-medium mb-2">用户名</label><div className="relative">
              <User className="login-modal-field-icon absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] pointer-events-none" />
              <input id="register-username" value={username} onChange={e => setUsername(e.target.value)} required maxLength={50} autoComplete="nickname" placeholder="你的昵称" className="login-modal-field w-full rounded-xl pl-11 pr-4 py-3 text-sm" />
            </div></div>}
            <div>
              <label htmlFor="login-email" className="login-modal-label block text-sm font-medium mb-2">邮箱</label>
              <div className="relative">
                <Mail className="login-modal-field-icon absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] pointer-events-none" />
                <input
                  id="login-email"
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="your@email.com" required autoFocus
                  autoComplete="email"
                  className="login-modal-field w-full rounded-xl pl-11 pr-4 py-3 text-sm"
                />
              </div>
            </div>

            <div>
              <label htmlFor="login-password" className="login-modal-label block text-sm font-medium mb-2">密码</label>
              <div className="relative">
                <Lock className="login-modal-field-icon absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] pointer-events-none" />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="请输入密码" required minLength={6}
                  maxLength={isRegister ? 72 : undefined} autoComplete={isRegister ? 'new-password' : 'current-password'}
                  className="login-modal-field w-full rounded-xl pl-11 pr-12 py-3 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(value => !value)}
                  className="login-modal-password-toggle absolute right-1.5 top-1/2 -translate-y-1/2"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
                </button>
              </div>
            </div>

            {isRegister && <div><label htmlFor="register-confirm-password" className="login-modal-label block text-sm font-medium mb-2">确认密码</label><div className="relative">
              <Lock className="login-modal-field-icon absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] pointer-events-none" />
              <input id="register-confirm-password" type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required minLength={6} maxLength={72} autoComplete="new-password" placeholder="再次输入密码" className="login-modal-field w-full rounded-xl pl-11 pr-4 py-3 text-sm" />
            </div></div>}

            {error && (
              <div className="login-modal-error rounded-xl px-4 py-3 text-sm" role="alert">
                {error}
              </div>
            )}

            <button
              type="submit" disabled={loading}
              className="login-modal-submit w-full font-semibold py-3 rounded-xl flex items-center justify-center gap-2"
            >
              {loading ? (
                <><div className="w-5 h-5 border-2 border-white/35 border-t-white rounded-full animate-spin" /><span>{isRegister ? '注册中…' : '登录中…'}</span></>
              ) : (
                <>{isRegister ? '注册并登录' : '登录'}<ArrowRight className="w-4 h-4" /></>
              )}
            </button>
          </form>

          {/* 登录与注册共用会话流程 */}
          <div className="mt-6 pt-5 border-t login-modal-divider text-center">
            <div className="login-modal-help flex items-center justify-center gap-2 text-sm">
              <span>{isRegister ? '已有账号？' : '没有账号？'}</span><button type="button" disabled={loading} onClick={() => { setIsRegister(value => !value); setError(''); setPassword(''); setConfirmPassword(''); }}>{isRegister ? '返回登录' : '立即注册'}</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
