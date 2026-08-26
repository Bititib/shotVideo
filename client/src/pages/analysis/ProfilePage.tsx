import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Copy,
  Gauge,
  KeyRound,
  Mail,
  MessageCircle,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
  WalletCards,
  Zap,
} from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { authApi } from '../../api/auth';
import { getPublicSettings } from '../../api/admin';
import { tokensApi } from '../../api/tokens';

const roleLabels: Record<string, string> = {
  super_admin: '超级管理员',
  admin: '系统管理员',
  user: '普通用户',
};

const featureList = ['通用与带货分析', '图片生成与逆向', '多模型视频生成', '创意分镜工作室'];

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
  const [tokenError, setTokenError] = useState('');

  const loadTokens = async () => {
    setTokensLoading(true);
    setTokenError('');
    try {
      const response = await tokensApi.getTokens();
      setTokens(response.items || []);
    } catch (error: any) {
      setTokenError(error.message || 'API Key 加载失败');
    } finally {
      setTokensLoading(false);
    }
  };

  useEffect(() => {
    getPublicSettings().then(setContactInfo).catch(() => {});
    loadTokens();
  }, []);

  const handleCreateToken = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newTokenName.trim()) return;
    setTokenError('');
    try {
      const response = await tokensApi.createToken({ name: newTokenName.trim() });
      setNewTokenKey(response.tokenKey);
      setNewTokenName('');
      await loadTokens();
    } catch (error: any) {
      setTokenError(error.message || 'API Key 创建失败');
    }
  };

  const handleDeleteToken = async (id: number) => {
    if (!confirm('确定删除此 API Key 吗？删除后无法恢复。')) return;
    try {
      await tokensApi.deleteToken(id);
      await loadTokens();
    } catch (error: any) {
      setTokenError(error.message || '删除失败');
    }
  };

  const handleToggleTokenStatus = async (token: any) => {
    try {
      await tokensApi.updateToken(token.id, { status: token.status ? 0 : 1 });
      await loadTokens();
    } catch (error: any) {
      setTokenError(error.message || '状态更新失败');
    }
  };

  const handleChangePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setCpError(null);
    setCpSuccess(null);
    if (!oldPassword || !newPassword || !confirmPassword) return setCpError('请填写全部密码字段');
    if (newPassword.length < 6) return setCpError('新密码至少需要 6 位');
    if (newPassword !== confirmPassword) return setCpError('两次输入的新密码不一致');

    setCpLoading(true);
    try {
      await authApi.changePassword(oldPassword, newPassword);
      setCpSuccess('登录密码已更新');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error: any) {
      setCpError(error.message || '密码修改失败，请重试');
    } finally {
      setCpLoading(false);
    }
  };

  const handleCopyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  if (!user) {
    return <div className="profile-empty"><User className="w-7 h-7" /><p>请先登录以查看个人信息</p></div>;
  }

  const quotaUnlimited = user.tier?.dailyQuota === -1;
  const quotaPercent = user.tier?.dailyQuota && user.tier.dailyQuota > 0
    ? Math.min(100, Math.round((user.usedToday / user.tier.dailyQuota) * 100))
    : 0;
  const avatarText = (user.username || user.email || 'U').slice(0, 1).toUpperCase();

  return (
    <div className="profile-page max-w-7xl mx-auto p-4 md:p-8">
      <header className="profile-hero">
        <div className="profile-hero-copy">
          <div className="profile-eyebrow"><User className="w-4 h-4" /> Account center</div>
          <h1>个人中心</h1>
          <p>集中管理账户信息、创作额度、安全设置与开发者密钥。</p>
        </div>
        <div className="profile-identity">
          <div className="profile-avatar" aria-hidden="true">{avatarText}</div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2>{user.username || '未设置用户名'}</h2>
              <span className="profile-status-badge">{user.tier?.displayName || '免费用户'}</span>
              {user.role !== 'user' && <span className="profile-role-badge">{roleLabels[user.role] || user.role}</span>}
            </div>
            <p className="profile-email"><Mail className="w-3.5 h-3.5" /> {user.email}</p>
          </div>
        </div>
      </header>

      <section className="profile-metrics" aria-label="账户概览">
        <div className="profile-metric-card">
          <div className="profile-metric-icon"><WalletCards className="w-5 h-5" /></div>
          <div><span>账户余额</span><strong>¥{Number(user.balance || 0).toFixed(2)}</strong></div>
        </div>
        <div className="profile-metric-card">
          <div className="profile-metric-icon is-amber"><Gauge className="w-5 h-5" /></div>
          <div><span>今日用量</span><strong>{user.usedToday}<small> / {quotaUnlimited ? '不限' : user.tier?.dailyQuota ?? 0}</small></strong></div>
        </div>
        <div className="profile-metric-card">
          <div className="profile-metric-icon is-moss"><ShieldCheck className="w-5 h-5" /></div>
          <div><span>账户身份</span><strong className="is-text">{roleLabels[user.role] || user.role}</strong></div>
        </div>
        <div className="profile-metric-card">
          <div className="profile-metric-icon is-clay"><CalendarDays className="w-5 h-5" /></div>
          <div><span>注册时间</span><strong className="is-text">{new Date(user.createdAt).toLocaleDateString('zh-CN')}</strong></div>
        </div>
      </section>

      <div className="profile-layout">
        <main className="profile-main-column">
          <section className="profile-card">
            <div className="profile-section-heading">
              <div className="profile-section-icon"><KeyRound className="w-4 h-4" /></div>
              <div><h2>修改登录密码</h2><p>定期更新密码可以提升账户安全性。</p></div>
            </div>
            <form onSubmit={handleChangePassword} className="profile-password-form">
              <div className="profile-field profile-field-wide">
                <label htmlFor="current-password">当前密码</label>
                <input id="current-password" type="password" autoComplete="current-password" value={oldPassword} onChange={event => setOldPassword(event.target.value)} placeholder="输入当前使用的密码" />
              </div>
              <div className="profile-field">
                <label htmlFor="new-password">新密码</label>
                <input id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder="至少 6 位" />
              </div>
              <div className="profile-field">
                <label htmlFor="confirm-password">确认新密码</label>
                <input id="confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="再次输入新密码" />
              </div>
              {cpError && <div role="alert" className="profile-feedback is-error"><AlertCircle className="w-4 h-4" /> {cpError}</div>}
              {cpSuccess && <div role="status" className="profile-feedback is-success"><CheckCircle2 className="w-4 h-4" /> {cpSuccess}</div>}
              <div className="profile-field-wide">
                <button type="submit" disabled={cpLoading} className="profile-primary-button">
                  {cpLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  {cpLoading ? '正在更新…' : '更新密码'}
                </button>
              </div>
            </form>
          </section>

          <section className="profile-card">
            <div className="profile-section-heading profile-section-heading-row">
              <div className="flex items-start gap-3">
                <div className="profile-section-icon"><KeyRound className="w-4 h-4" /></div>
                <div><h2>开发者 API Key</h2><p>调用开放 API 时，费用将从当前账户余额扣除。</p></div>
              </div>
              <span className="profile-count-badge">{tokens.length} 个密钥</span>
            </div>

            {newTokenKey && (
              <div className="profile-token-created" role="status">
                <div className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 mt-0.5" /><p><strong>API Key 创建成功</strong><br />请立即复制保存，此密钥只展示一次。</p></div>
                <div className="profile-secret-row">
                  <code>{newTokenKey}</code>
                  <button onClick={() => handleCopyText(newTokenKey)}><Copy className="w-4 h-4" />复制</button>
                </div>
                <button className="profile-dismiss-button" onClick={() => setNewTokenKey(null)}>我已保存，关闭提示</button>
              </div>
            )}

            <form onSubmit={handleCreateToken} className="profile-token-create">
              <div className="profile-field">
                <label htmlFor="token-name">密钥名称</label>
                <input id="token-name" value={newTokenName} onChange={event => setNewTokenName(event.target.value)} placeholder="例如：自动化工作流" />
              </div>
              <button type="submit" disabled={!newTokenName.trim()} className="profile-primary-button"><Plus className="w-4 h-4" />新建 Key</button>
            </form>

            {tokenError && <div role="alert" className="profile-feedback is-error"><AlertCircle className="w-4 h-4" />{tokenError}</div>}
            <div className="profile-token-list">
              {tokensLoading && <div className="profile-list-state"><RefreshCw className="w-4 h-4 animate-spin" />正在加载密钥…</div>}
              {!tokensLoading && tokens.map(token => (
                <div key={token.id} className={`profile-token-item ${token.status ? '' : 'is-disabled'}`}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong>{token.name || '未命名 Key'}</strong>
                      <span className={`profile-token-status ${token.status ? 'is-active' : ''}`}>{token.status ? '已启用' : '已停用'}</span>
                    </div>
                    <code>{token.tokenKeyMasked}</code>
                  </div>
                  <div className="profile-token-actions">
                    <button onClick={() => handleToggleTokenStatus(token)} aria-label={`${token.status ? '停用' : '启用'} ${token.name || 'API Key'}`}>
                      {token.status ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}{token.status ? '停用' : '启用'}
                    </button>
                    <button className="is-danger" onClick={() => handleDeleteToken(token.id)} aria-label={`删除 ${token.name || 'API Key'}`}><Trash2 className="w-4 h-4" />删除</button>
                  </div>
                </div>
              ))}
              {!tokensLoading && tokens.length === 0 && <div className="profile-list-state">暂无 API Key，可在上方创建。</div>}
            </div>
          </section>
        </main>

        <aside className="profile-side-column">
          <section className="profile-card profile-quota-card">
            <div className="profile-section-heading">
              <div className="profile-section-icon is-amber"><Zap className="w-4 h-4" /></div>
              <div><h2>套餐与额度</h2><p>{user.tier?.displayName || '免费用户'}</p></div>
            </div>
            <div className="profile-quota-value"><strong>{user.usedToday}</strong><span>/ {quotaUnlimited ? '不限' : user.tier?.dailyQuota ?? 0} 次</span></div>
            {!quotaUnlimited && (
              <div className="profile-progress-wrap">
                <div><span>今日额度使用</span><strong>{quotaPercent}%</strong></div>
                <div className="profile-progress"><span style={{ width: `${quotaPercent}%` }} /></div>
              </div>
            )}
            <div className="profile-feature-list">
              {featureList.map(feature => <div key={feature}><CheckCircle2 className="w-4 h-4" /><span>{feature}</span></div>)}
            </div>
          </section>

          <section className="profile-card profile-balance-help">
            <div className="profile-section-heading">
              <div className="profile-section-icon is-moss"><WalletCards className="w-4 h-4" /></div>
              <div><h2>充值与续费</h2><p>当前暂未开放在线自助充值。</p></div>
            </div>
            <p>需要充值余额或调整套餐时，请联系管理员并提供当前账户邮箱。</p>
          </section>

          {(contactInfo.contact_wechat || contactInfo.contact_qq) && (
            <section className="profile-card">
              <div className="profile-section-heading">
                <div className="profile-section-icon is-clay"><Sparkles className="w-4 h-4" /></div>
                <div><h2>升级与专属支持</h2><p>获取更高额度和企业级支持。</p></div>
              </div>
              <div className="profile-contact-list">
                {contactInfo.contact_wechat && <button onClick={() => handleCopyText(contactInfo.contact_wechat)}><span><MessageCircle className="w-4 h-4" />客服微信</span><code>{contactInfo.contact_wechat}</code></button>}
                {contactInfo.contact_qq && <button onClick={() => handleCopyText(contactInfo.contact_qq)}><span>客服 QQ</span><code>{contactInfo.contact_qq}</code></button>}
              </div>
              {copied && <p className="profile-copy-success" role="status">已复制到剪贴板</p>}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
