import React, { useState, useEffect } from 'react';
import { User, Mail, Shield, Zap, Key, CreditCard, CheckCircle2, Copy, AlertCircle, Sparkles, MessageCircle, RefreshCw, Plus, Trash2, Power, PowerOff, Check } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { authApi } from '../../api/auth';
import { getPublicSettings } from '../../api/admin';
import { tokensApi } from '../../api/tokens';

export default function ProfilePage() {
  const { user } = useAuthStore();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [cpError, setCpError] = useState<string | null>(null);
  const [cpSuccess, setCpSuccess] = useState<string | null>(null);
  const [cpLoading, setCpLoading] = useState(false);

  const [copied, setCopied] = useState(false);
  const [contactInfo, setContactInfo] = useState<Record<string, string>>({});

  const [tokens, setTokens] = useState<any[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [newTokenKey, setNewTokenKey] = useState<string | null>(null);
  const [copiedTokenId, setCopiedTokenId] = useState<number | null>(null);

  const loadTokens = async () => {
    setTokensLoading(true);
    try {
      const res = await tokensApi.getTokens();
      setTokens(res.items || []);
    } catch (e) {
      console.error(e);
    }
    setTokensLoading(false);
  };

  useEffect(() => {
    getPublicSettings().then(setContactInfo).catch(() => {});
    loadTokens();
  }, []);

  const handleCreateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTokenName.trim()) return;
    try {
      const res = await tokensApi.createToken({ name: newTokenName.trim() });
      setNewTokenKey(res.tokenKey);
      setNewTokenName('');
      loadTokens();
    } catch (err: any) {
      alert(err.message || '创建失败');
    }
  };

  const handleDeleteToken = async (id: number) => {
    if (!confirm('确定删除此 API Key？')) return;
    try {
      await tokensApi.deleteToken(id);
      loadTokens();
    } catch (err: any) {
      alert(err.message || '删除失败');
    }
  };

  const handleToggleTokenStatus = async (token: any) => {
    try {
      await tokensApi.updateToken(token.id, { status: token.status ? 0 : 1 });
      loadTokens();
    } catch (err: any) {
      alert(err.message || '操作失败');
    }
  };

  const copyTokenKey = (tokenKey: string, id: number) => {
    navigator.clipboard.writeText(tokenKey);
    setCopiedTokenId(id);
    setTimeout(() => setCopiedTokenId(null), 2000);
  };

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
      await authApi.changePassword(oldPassword, newPassword);
      setCpSuccess('密码修改成功');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      setCpError(err.message || '密码修改失败，请重试');
    } finally {
      setCpLoading(false);
    }
  };

  const handleCopyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!user) {
    return (
      <div className="flex-1 flex items-center justify-center h-full min-h-[500px]">
        <p className="text-zinc-500 text-sm">请先登录以查看个人信息</p>
      </div>
    );
  }

  const roleLabels: Record<string, string> = {
    super_admin: '超级管理员',
    admin: '系统管理员',
    user: '普通用户',
  };

  const tierColors: Record<string, string> = {
    free: 'from-zinc-500/20 to-zinc-600/20 border-zinc-700 text-zinc-400',
    basic: 'from-amber-500/20 to-yellow-600/20 border-amber-500/30 text-amber-400',
    pro: 'from-blue-500/20 to-indigo-600/20 border-blue-500/30 text-blue-400',
    enterprise: 'from-purple-500/20 to-pink-600/20 border-purple-500/30 text-purple-400',
  };

  const quotaPercent = user.tier?.dailyQuota && user.tier.dailyQuota > 0
    ? Math.min(100, Math.round((user.usedToday / user.tier.dailyQuota) * 100))
    : 0;

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-6">
      {/* 头部面包屑 / 标题 */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
          <User className="w-6 h-6 text-indigo-400" /> 个人中心
        </h1>
        <p className="text-xs text-zinc-500">管理您的账户信息、会员状态与修改密码</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 左侧：用户信息 & 套餐用量 */}
        <div className="lg:col-span-2 space-y-6">
          {/* 用户基础信息卡片 */}
          <div className="bg-zinc-950/60 border border-white/5 rounded-2xl p-6 relative overflow-hidden backdrop-blur-md">
            <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/5 rounded-full blur-3xl" />
            <div className="flex flex-col sm:flex-row items-center gap-5 relative z-10">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center text-xl font-bold text-white shadow-xl shadow-indigo-500/10 shrink-0">
                {user.username ? user.username[0].toUpperCase() : user.email[0].toUpperCase()}
              </div>
              <div className="flex-1 text-center sm:text-left">
                <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                  <h2 className="text-lg font-bold text-white">{user.username || '未设置用户名'}</h2>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${tierColors[user.tier?.name || 'free']}`}>
                    {user.tier?.displayName || '免费用户'}
                  </span>
                  {user.role !== 'user' && (
                    <span className="text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded-full">
                      {roleLabels[user.role] || user.role}
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-400 mt-1 flex items-center justify-center sm:justify-start gap-1.5">
                  <Mail className="w-3.5 h-3.5 text-zinc-500" /> {user.email}
                </p>
                <p className="text-[10px] text-zinc-600 mt-1">注册时间：{new Date(user.createdAt).toLocaleDateString()}</p>
              </div>
            </div>
          </div>

          {/* 套餐用量面板 */}
          <div className="bg-zinc-950/60 border border-white/5 rounded-2xl p-6 relative overflow-hidden backdrop-blur-md">
            <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <Zap className="w-4 h-4 text-indigo-400" /> 套餐与配额
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* 今日限额 */}
              <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4 flex flex-col justify-between">
                <div>
                  <span className="text-xs text-zinc-500 block mb-1">今日可用配额 (次/天)</span>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-2xl font-bold text-white">{user.usedToday}</span>
                    <span className="text-zinc-600 text-sm">/</span>
                    <span className="text-lg text-zinc-400 font-semibold">
                      {user.tier?.dailyQuota === -1 ? '无限' : user.tier?.dailyQuota}
                    </span>
                  </div>
                </div>

                {user.tier?.dailyQuota !== -1 && (
                  <div className="mt-4">
                    <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
                      <span>已消耗百分比</span>
                      <span>{quotaPercent}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all duration-500"
                        style={{ width: `${quotaPercent}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* 支持的功能权限 */}
              <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
                <span className="text-xs text-zinc-500 block mb-3">支持的专享权益</span>
                <div className="grid grid-cols-2 gap-2 text-xs text-zinc-300">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>通用/带货分析</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>图片生成/逆向</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>视频生成 (多模型)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>分镜工作室</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 修改密码面板 */}
          <div className="bg-zinc-950/60 border border-white/5 rounded-2xl p-6 relative overflow-hidden backdrop-blur-md">
            <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <Key className="w-4 h-4 text-indigo-400" /> 修改登录密码
            </h3>

            <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 mb-1.5">当前密码</label>
                <input
                  type="password"
                  value={oldPassword}
                  onChange={e => setOldPassword(e.target.value)}
                  className="w-full bg-white/[0.03] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 placeholder:text-zinc-700"
                  placeholder="请输入当前所用密码"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 mb-1.5">新密码</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="w-full bg-white/[0.03] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 placeholder:text-zinc-700"
                    placeholder="新密码（至少6位）"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 mb-1.5">确认新密码</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    className="w-full bg-white/[0.03] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 placeholder:text-zinc-700"
                    placeholder="请再次输入新密码"
                  />
                </div>
              </div>

              {cpError && (
                <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{cpError}</span>
                </div>
              )}

              {cpSuccess && (
                <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{cpSuccess}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={cpLoading}
                className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {cpLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                修改密码
              </button>
            </form>
          </div>

          {/* API Key 管理面板 */}
          <div className="bg-zinc-950/60 border border-white/5 rounded-2xl p-6 relative overflow-hidden backdrop-blur-md">
            <h3 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
              <Key className="w-4 h-4 text-indigo-400" /> 开发者 API Key
            </h3>
            <p className="text-[10px] text-zinc-500 mb-4">创建您专属的 API 密钥以对接第三方客户端，所有 API 调用将从您的主账户余额中扣除。</p>

            {/* 新建 Token Key 成功展示 */}
            {newTokenKey && (
              <div className="mb-4 bg-green-500/10 border border-green-500/30 rounded-xl p-4">
                <p className="text-xs text-green-400 mb-1.5">✅ API Key 创建成功！请立即复制保存，此 Key 仅展示一次：</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-black/30 rounded-lg px-3 py-1.5 text-xs text-green-300 font-mono break-all">{newTokenKey}</code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(newTokenKey); }}
                    className="px-2.5 py-1.5 bg-green-600 hover:bg-green-500 rounded-lg text-white text-xs flex items-center gap-1 transition-colors"
                  >
                    <Copy className="w-3.5 h-3.5" /> 复制
                  </button>
                </div>
                <button onClick={() => setNewTokenKey(null)} className="mt-2 text-[10px] text-zinc-400 hover:text-zinc-300">我已保存，关闭提示</button>
              </div>
            )}

            {/* 新建 Key 表单 */}
            <form onSubmit={handleCreateToken} className="flex gap-2 mb-5">
              <input
                type="text"
                value={newTokenName}
                onChange={e => setNewTokenName(e.target.value)}
                placeholder="输入 Key 的名称（例如：画图测试）"
                className="flex-1 bg-white/[0.03] border border-white/5 rounded-xl px-4 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 placeholder:text-zinc-700"
              />
              <button
                type="submit"
                disabled={!newTokenName.trim()}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-medium transition-colors flex items-center gap-1 shrink-0"
              >
                <Plus className="w-3.5 h-3.5" /> 新建 Key
              </button>
            </form>

            {/* Key 列表 */}
            <div className="space-y-3">
              {tokensLoading && <div className="text-center py-4 text-xs text-zinc-500">加载中...</div>}
              {!tokensLoading && tokens.map(t => (
                <div key={t.id} className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 bg-white/[0.01] border rounded-xl ${t.status ? 'border-white/5' : 'border-red-500/10 opacity-60'}`}>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-white">{t.name || '未命名'}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${t.status ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
                        {t.status ? '已启用' : '已禁用'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <code className="text-[10px] text-zinc-500 font-mono">{t.tokenKeyMasked || (t.tokenKey.slice(0, 6) + '****' + t.tokenKey.slice(-4))}</code>
                      <button onClick={() => copyTokenKey(t.tokenKey, t.id)} className="text-zinc-500 hover:text-zinc-300">
                        {copiedTokenId === t.id ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleToggleTokenStatus(t)}
                      className={`text-[10px] px-2.5 py-1 rounded-lg transition-colors ${t.status ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300' : 'bg-green-600/15 hover:bg-green-600/25 text-green-400'}`}
                    >
                      {t.status ? '禁用' : '启用'}
                    </button>
                    <button
                      onClick={() => handleDeleteToken(t.id)}
                      className="text-[10px] px-2.5 py-1 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-red-400 transition-colors"
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
              {!tokensLoading && tokens.length === 0 && (
                <div className="text-center py-6 text-xs text-zinc-600 border border-dashed border-white/5 rounded-xl">暂无可用 API Key，在上方输入名称即可快速创建。</div>
              )}
            </div>
          </div>
        </div>

        {/* 右侧：账户余额 & 客服升级 */}
        <div className="space-y-6">
          {/* 账户余额卡片 */}
          <div className="bg-gradient-to-br from-indigo-950/40 via-purple-950/20 to-black border border-indigo-500/20 rounded-2xl p-6 relative overflow-hidden backdrop-blur-md">
            <div className="absolute top-0 right-0 w-24 h-24 bg-purple-500/10 rounded-full blur-2xl" />
            <h3 className="text-xs font-semibold text-indigo-300 mb-1 flex items-center gap-1.5">
              <CreditCard className="w-3.5 h-3.5 text-indigo-400" /> 账户余额
            </h3>
            <div className="flex items-baseline gap-1.5 mt-2">
              <span className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-white via-zinc-100 to-zinc-300">
                ¥{user.balance.toFixed(2)}
              </span>
            </div>

            {/* 充值指引 */}
            <div className="mt-6 border-t border-white/5 pt-4">
              <span className="text-xs text-zinc-400 block mb-2 font-medium">充值与续费</span>
              <p className="text-xs text-zinc-500 leading-relaxed">
                本平台暂未开启在线自助充值通道。如需充值账户余额或购买/续费套餐，请联系系统管理员或下方客服，提供您的账户邮箱进行人工充值入账。
              </p>
            </div>
          </div>

          {/* 会员等级升级入口 */}
          {(contactInfo.contact_wechat || contactInfo.contact_qq) && (
            <div className="bg-zinc-950/60 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
              <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-yellow-400" /> 升级专享尊贵特权
              </h3>
              <p className="text-xs text-zinc-400 leading-relaxed mb-4">
                如需获得更高限额的日可用次数、专属大模型接口、专属服务器并发以及专业的定制短视频支持，请扫描或复制下方客服信息。
              </p>
              <div className="space-y-2 text-xs border-t border-white/5 pt-3">
                {contactInfo.contact_wechat && (
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500 flex items-center gap-1"><MessageCircle className="w-3.5 h-3.5" /> 客服微信</span>
                    <button
                      onClick={() => handleCopyText(contactInfo.contact_wechat)}
                      className="text-indigo-400 hover:text-indigo-300 font-mono select-all bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded cursor-pointer"
                    >
                      {contactInfo.contact_wechat}
                    </button>
                  </div>
                )}
                {contactInfo.contact_qq && (
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">客服QQ</span>
                    <button
                      onClick={() => handleCopyText(contactInfo.contact_qq)}
                      className="text-indigo-400 hover:text-indigo-300 font-mono select-all bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded cursor-pointer"
                    >
                      {contactInfo.contact_qq}
                    </button>
                  </div>
                )}
                {copied && (
                  <p className="text-[10px] text-center text-emerald-400 animate-pulse mt-1">已成功复制客服号到剪切板</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
