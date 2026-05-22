import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { Zap, PlaySquare, ShoppingBag, Image as ImageIcon, Megaphone, Users, ArrowRight, Check, Star, Sparkles, TrendingUp, Shield, Globe } from 'lucide-react';

const features = [
  { icon: PlaySquare, title: '通用视频分析', desc: '一键逆向任意短视频的创意策略、提示词与镜头语言', color: 'from-blue-500 to-cyan-500' },
  { icon: ShoppingBag, title: '带货视频分析', desc: '识别商品、拆解卖点、Hook分析，支持一键换品', color: 'from-purple-500 to-pink-500' },
  { icon: ImageIcon, title: '图片逆向引擎', desc: '生成MJ/SD提示词，提取TikTok图文音频', color: 'from-pink-500 to-rose-500' },
  { icon: Megaphone, title: '爆款文案生成', desc: 'TikTok + Amazon Listing + A+详情页一键出稿', color: 'from-orange-500 to-amber-500' },
  { icon: Users, title: '账号全方位分析', desc: '内容/粉丝/运营/涨粉策略 + AI头像封面生成', color: 'from-emerald-500 to-teal-500' },
  { icon: Sparkles, title: 'AI 图像生成', desc: '高质量产品底图、电商场景图一键合成', color: 'from-violet-500 to-indigo-500' },
];

const tiers = [
  {
    name: '免费体验', price: '¥0', period: '/永久', desc: '适合个人尝鲜',
    features: ['通用视频分析', '图片逆向分析', '带货视频分析', '每日3次调用'],
    color: 'border-white/10', bg: 'bg-white/[0.02]', badge: '',
  },
  {
    name: '基础会员', price: '¥99', period: '/月', desc: '内容创作者首选',
    features: ['全部5项分析功能', '每日30次调用', '优先客服支持', '历史记录保留'],
    color: 'border-yellow-500/30', bg: 'bg-gradient-to-b from-yellow-500/5 to-transparent', badge: '',
  },
  {
    name: '专业会员', price: '¥299', period: '/月', desc: '电商团队必备',
    features: ['全部功能 + AI生图', '一键换品', '每日100次调用', '专属模型通道', '团队协作（即将上线）'],
    color: 'border-blue-500/30', bg: 'bg-gradient-to-b from-blue-500/5 to-transparent', badge: '最受欢迎',
  },
  {
    name: '企业定制', price: '联系我们', period: '', desc: '大规模商用',
    features: ['不限调用次数', '私有化部署', 'API接口开放', '专属模型微调', '1对1技术支持'],
    color: 'border-purple-500/30', bg: 'bg-gradient-to-b from-purple-500/5 to-transparent', badge: '',
  },
];

const stats = [
  { value: '50,000+', label: '分析次数' },
  { value: '2,000+', label: '活跃用户' },
  { value: '5', label: '核心功能' },
  { value: '<30s', label: '平均响应' },
];

export default function LandingPage() {
  const navigate = useNavigate();
  const { user, openLoginModal } = useAuthStore();

  const handleCTA = () => navigate('/app');

  return (
    <div className="min-h-screen bg-black text-white overflow-x-hidden">
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">短视频创意风暴</span>
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm text-zinc-400">
            <a href="#features" className="hover:text-white transition-colors">功能</a>
            <a href="#pricing" className="hover:text-white transition-colors">定价</a>
            <a href="#faq" className="hover:text-white transition-colors">FAQ</a>
          </div>
          <div className="flex items-center gap-3">
            {user ? (
              <button onClick={() => navigate('/app')} className="px-5 py-2 bg-gradient-to-r from-blue-600 to-purple-600 rounded-xl text-sm font-medium hover:from-blue-500 hover:to-purple-500 transition-all">
                进入工作台
              </button>
            ) : (
              <>
                <button onClick={() => navigate('/app')} className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors">进入工作台</button>
                <button onClick={openLoginModal} className="px-5 py-2 bg-gradient-to-r from-blue-600 to-purple-600 rounded-xl text-sm font-medium hover:from-blue-500 hover:to-purple-500 transition-all">
                  登录
                </button>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative pt-32 pb-20 md:pt-44 md:pb-32 px-6">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-600/10 via-transparent to-transparent" />
        <div className="absolute top-20 left-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-[120px]" />
        <div className="absolute top-40 right-1/4 w-72 h-72 bg-blue-600/10 rounded-full blur-[100px]" />

        <div className="relative max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-white/[0.05] border border-white/10 rounded-full text-xs text-zinc-400 mb-8">
            <Sparkles className="w-3.5 h-3.5 text-yellow-400" />
            <span>基于 Gemini 2.5 大模型深度分析</span>
          </div>

          <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold leading-tight tracking-tight mb-6">
            <span className="text-white">一键逆向</span>
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400">
              爆款短视频的创意密码
            </span>
          </h1>

          <p className="text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            上传任意短视频或粘贴 TikTok 链接，AI 为你深度拆解视频策略、逆向提示词、
            生成带货文案、分析竞品账号 —— 让每一条视频都值得学习。
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <button onClick={handleCTA} className="group px-8 py-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 rounded-2xl text-base font-semibold transition-all flex items-center gap-2 shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30">
              免费开始使用
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </button>
            <a href="#features" className="px-8 py-4 border border-white/10 hover:border-white/20 rounded-2xl text-base text-zinc-300 transition-colors">
              了解更多
            </a>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 max-w-3xl mx-auto">
            {stats.map((s, i) => (
              <div key={i} className="text-center">
                <p className="text-2xl md:text-3xl font-bold text-white">{s.value}</p>
                <p className="text-xs text-zinc-500 mt-1">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20 md:py-32 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">六大核心功能</h2>
            <p className="text-zinc-400 text-lg">覆盖短视频创作全链路，从灵感到落地一站搞定</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f, i) => (
              <div key={i} className="group bg-white/[0.02] border border-white/5 hover:border-white/10 rounded-2xl p-6 transition-all hover:bg-white/[0.04]">
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${f.color} flex items-center justify-center mb-5 opacity-80 group-hover:opacity-100 transition-opacity`}>
                  <f.icon className="w-6 h-6 text-white" />
                </div>
                <h3 className="text-lg font-semibold text-white mb-2">{f.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-20 md:py-32 px-6 bg-white/[0.01]">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">三步开始</h2>
            <p className="text-zinc-400 text-lg">简单到不需要教程</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              { step: '01', title: '上传或粘贴链接', desc: '支持 TikTok、YouTube 链接直接导入，或上传本地视频/图片', icon: Globe },
              { step: '02', title: 'AI 深度分析', desc: 'Gemini 2.5 大模型逐帧解析视频内容、策略和创意手法', icon: TrendingUp },
              { step: '03', title: '获取创意方案', desc: '逆向提示词、爆款文案、竞品分析一键复制，直接落地', icon: Sparkles },
            ].map((s, i) => (
              <div key={i} className="relative">
                <div className="text-6xl font-black text-white/[0.03] absolute -top-4 -left-2">{s.step}</div>
                <div className="relative bg-white/[0.02] border border-white/5 rounded-2xl p-6">
                  <s.icon className="w-8 h-8 text-blue-400 mb-4" />
                  <h3 className="text-base font-semibold text-white mb-2">{s.title}</h3>
                  <p className="text-sm text-zinc-400 leading-relaxed">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 md:py-32 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">灵活定价</h2>
            <p className="text-zinc-400 text-lg">从免费体验到企业定制，找到最适合你的方案</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {tiers.map((t, i) => (
              <div key={i} className={`relative ${t.bg} border ${t.color} rounded-2xl p-6 flex flex-col`}>
                {t.badge && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 bg-gradient-to-r from-blue-600 to-purple-600 rounded-full text-[10px] font-bold tracking-wider uppercase whitespace-nowrap">
                    {t.badge}
                  </div>
                )}
                <div className="mb-6">
                  <h3 className="text-lg font-semibold text-white mb-1">{t.name}</h3>
                  <p className="text-xs text-zinc-500 mb-4">{t.desc}</p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold text-white">{t.price}</span>
                    <span className="text-xs text-zinc-500">{t.period}</span>
                  </div>
                </div>
                <ul className="space-y-3 mb-8 flex-1">
                  {t.features.map((f, j) => (
                    <li key={j} className="flex items-start gap-2 text-sm text-zinc-300">
                      <Check className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                      {f}
                    </li>
                  ))}
                </ul>
                <button onClick={handleCTA} className={`w-full py-3 rounded-xl text-sm font-medium transition-all ${
                  t.badge
                    ? 'bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white'
                    : 'bg-white/5 hover:bg-white/10 text-zinc-300'
                }`}>
                  {t.price === '联系我们' ? '联系我们' : '立即开始'}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-20 md:py-32 px-6 bg-white/[0.01]">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">常见问题</h2>
          </div>

          <div className="space-y-4">
            {[
              { q: '支持哪些平台的视频？', a: '目前支持 TikTok 和 YouTube 链接直接导入，同时支持上传本地 MP4/MOV/AVI/WebM 格式视频，最大 150MB。' },
              { q: 'AI 分析的准确度如何？', a: '我们使用 Google Gemini 2.5 大模型，是目前最先进的多模态 AI 之一，能逐帧理解视频内容并给出专业级分析。' },
              { q: '免费用户有什么限制？', a: '免费用户可以体验通用分析、图片逆向和带货分析功能，每日 3 次调用额度。升级会员可解锁全部功能和更多额度。' },
              { q: '数据安全吗？', a: '您上传的视频在分析完成后立即删除，不会保留任何原始文件。所有传输均采用 HTTPS 加密。' },
              { q: '可以申请退款吗？', a: '我们提供 7 天无理由退款保障。如果对服务不满意，联系客服即可全额退款。' },
            ].map((item, i) => (
              <details key={i} className="group bg-white/[0.02] border border-white/5 rounded-2xl overflow-hidden">
                <summary className="px-6 py-4 cursor-pointer text-sm font-medium text-white flex items-center justify-between">
                  {item.q}
                  <span className="text-zinc-500 group-open:rotate-45 transition-transform text-lg">+</span>
                </summary>
                <div className="px-6 pb-4 text-sm text-zinc-400 leading-relaxed">{item.a}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 md:py-32 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <div className="bg-gradient-to-b from-white/[0.03] to-transparent border border-white/5 rounded-3xl p-12 md:p-16">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">准备好逆向下一个爆款了吗？</h2>
            <p className="text-zinc-400 text-lg mb-8">登录账号即可体验全部核心功能</p>
            <button onClick={handleCTA} className="group px-10 py-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 rounded-2xl text-base font-semibold transition-all inline-flex items-center gap-2 shadow-lg shadow-blue-500/20">
              进入工作台
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 py-12 px-6">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <Zap className="w-3 h-3 text-white" />
            </div>
            <span className="text-sm font-semibold text-zinc-400">短视频创意风暴</span>
          </div>
          <div className="flex items-center gap-6 text-xs text-zinc-600">
            <span>© 2026 All rights reserved</span>
            <a href="#" className="hover:text-zinc-400 transition-colors">隐私政策</a>
            <a href="#" className="hover:text-zinc-400 transition-colors">服务条款</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
