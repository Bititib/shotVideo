import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { getPublicSettings } from '../api/admin';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Clock,
  FileText,
  Globe,
  Image as ImageIcon,
  Layers3,
  Megaphone,
  PlaySquare,
  Shield,
  ShoppingBag,
  Sparkles,
  TrendingUp,
  Users,
  Video,
} from 'lucide-react';

const features = [
  { icon: PlaySquare, title: '通用视频分析', desc: '从镜头语言、内容结构到传播策略，完整拆解一条视频为什么有效。' },
  { icon: ShoppingBag, title: '带货视频分析', desc: '识别商品与核心卖点，定位 Hook、转化路径，并支持一键换品。' },
  { icon: ImageIcon, title: '图片逆向引擎', desc: '提取视觉风格与生成提示词，让优质画面能够被准确复现。' },
  { icon: Megaphone, title: '电商文案生成', desc: '生成 TikTok、Amazon Listing 与 A+ 页面所需的完整文案。' },
  { icon: Users, title: '账号策略分析', desc: '综合内容、受众与运营节奏，给出持续增长的账号策略。' },
  { icon: Sparkles, title: 'AI 图像与视频', desc: '从分析直接进入创作，让洞察、提示词和最终素材自然衔接。' },
];

const stats = [
  { value: '50,000+', label: '累计分析' },
  { value: '2,000+', label: '创作者使用' },
  { value: '9', label: '创作工具' },
  { value: '<30s', label: '平均响应' },
];

const steps = [
  { step: '01', icon: Globe, title: '导入内容', desc: '粘贴 TikTok、YouTube 链接，或上传本地视频与图片。' },
  { step: '02', icon: TrendingUp, title: '深度理解', desc: 'AI 逐帧识别内容结构、创意策略、镜头语言与转化设计。' },
  { step: '03', icon: Sparkles, title: '落地创意', desc: '得到提示词、文案和生成素材，直接进入下一轮创作。' },
];

const faqs = [
  { q: '支持哪些平台和文件格式？', a: '支持 TikTok、YouTube 链接直接导入，也支持上传 MP4、MOV、AVI、WebM 视频以及常见图片格式。' },
  { q: 'AI 分析结果可以直接用于创作吗？', a: '可以。结果会包含内容结构、镜头策略、提示词、文案与可执行建议，并可继续进入图片或视频生成流程。' },
  { q: '免费用户可以体验哪些能力？', a: '免费用户每天可以体验通用分析、图片逆向与带货分析。图片和视频生成按照实际使用量计费。' },
  { q: '上传的素材是否安全？', a: '平台仅在完成任务所需的范围内处理素材，并通过账户权限隔离内容。建议企业用户按自身要求配置私有部署方案。' },
];

export default function LandingPage() {
  const navigate = useNavigate();
  const { user, openLoginModal } = useAuthStore();
  const [settings, setSettings] = useState<Record<string, string>>({});

  useEffect(() => {
    getPublicSettings().then(setSettings).catch(() => {});
  }, []);

  const videoPrice = settings.video_rate_720p || '0.05';
  const imagePrice = settings.image_rate || '0.05';

  const tiers = [
    {
      name: '免费体验', price: '按需充值', period: '', desc: '适合个人探索',
      features: ['每日 3 次免费 AI 分析', '通用视频与图片逆向', `视频生成 ¥${videoPrice} / 秒起`, `图片生成 ¥${imagePrice} / 张起`],
    },
    {
      name: '基础会员', price: '¥99', period: '/月', desc: '适合稳定创作',
      features: ['每日 30 次 AI 分析', '解锁全部分析能力', '视频与图片按标准费率', '基础客服支持'],
    },
    {
      name: '专业会员', price: '¥299', period: '/月', desc: '适合电商团队', popular: true,
      features: ['每日 100 次 AI 分析', '解锁 AI 生图与换品', '生成任务优先排队', '运营级数据洞察'],
    },
    {
      name: '企业会员', price: '联系我们', period: '', desc: '适合规模化商用',
      features: ['不限 AI 分析次数', 'OpenAI 兼容 API', '批量生成内部折扣', '私有化部署方案'],
    },
  ];

  const goToWorkspace = () => navigate('/app');

  return (
    <div className="landing-page">
      <a href="#landing-main" className="landing-skip-link">跳到主要内容</a>

      <nav className="landing-nav" aria-label="首页导航">
        <div className="landing-nav-inner">
          <button type="button" className="landing-brand" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="返回首页顶部">
            <span className="landing-brand-mark" aria-hidden="true"><Layers3 /></span>
            <span className="landing-brand-copy">
              <strong>短视频创意风暴</strong>
              <small>AI CREATIVE STUDIO</small>
            </span>
          </button>

          <div className="landing-nav-links">
            <a href="#features">核心能力</a>
            <a href="#workflow">工作流程</a>
            <a href="#pricing">方案定价</a>
            <a href="#faq">常见问题</a>
          </div>

          <div className="landing-nav-actions">
            <button type="button" className="landing-text-btn" onClick={goToWorkspace}>进入工作台</button>
            {!user && <button type="button" className="landing-compact-btn" onClick={openLoginModal}>登录</button>}
          </div>
        </div>
      </nav>

      <main id="landing-main">
        <section className="landing-hero" aria-labelledby="hero-title">
          <div className="landing-hero-inner">
            <div className="landing-hero-copy">
              <div className="landing-eyebrow"><Sparkles aria-hidden="true" /> AI 驱动的短视频创意工作台</div>
              <h1 id="hero-title">看懂爆款，<br /><span>再创造下一个爆款。</span></h1>
              <p className="landing-hero-description">
                从视频分析、提示词逆向到图片与视频生成，把分散的创作步骤汇成一条清晰、可复用的工作流。
              </p>

              <div className="landing-hero-actions">
                <button type="button" className="landing-primary-btn" onClick={goToWorkspace}>
                  免费开始使用 <ArrowRight aria-hidden="true" />
                </button>
                <a href="#features" className="landing-secondary-btn">查看核心能力</a>
              </div>

              <div className="landing-trust-row" aria-label="产品优势">
                <span><Shield aria-hidden="true" /> 内容与账户隔离</span>
                <span><Clock aria-hidden="true" /> 分钟级完成分析</span>
                <span><Check aria-hidden="true" /> 无需安装软件</span>
              </div>
            </div>

            <div className="landing-product-visual" aria-label="产品分析界面示意">
              <div className="landing-visual-window">
                <div className="landing-window-bar">
                  <div className="landing-window-dots" aria-hidden="true"><i /><i /><i /></div>
                  <span>创意分析工作台</span>
                  <span className="landing-window-status"><i /> AI 已就绪</span>
                </div>
                <div className="landing-window-body">
                  <div className="landing-video-preview">
                    <div className="landing-video-badge"><Video /> 视频素材</div>
                    <button type="button" aria-label="播放示例视频"><PlaySquare /></button>
                    <div className="landing-video-timeline"><span /></div>
                  </div>
                  <div className="landing-insight-panel">
                    <div className="landing-insight-heading"><Sparkles /> AI 创意洞察 <span>分析完成</span></div>
                    <div className="landing-insight-card"><b>01</b><div><strong>3 秒视觉钩子</strong><p>先展示结果，再解释过程</p></div></div>
                    <div className="landing-insight-card"><b>02</b><div><strong>核心转化卖点</strong><p>突出对比与真实使用场景</p></div></div>
                    <div className="landing-insight-card"><b>03</b><div><strong>可复用提示词</strong><p>已整理镜头、角色与光线</p></div></div>
                  </div>
                </div>
              </div>
              <div className="landing-floating-card landing-floating-card-one"><FileText /> 已生成带货文案</div>
              <div className="landing-floating-card landing-floating-card-two"><TrendingUp /> 创意评分 92</div>
            </div>
          </div>

          <div className="landing-stats" aria-label="平台数据">
            {stats.map((stat) => <div key={stat.label}><strong>{stat.value}</strong><span>{stat.label}</span></div>)}
          </div>
        </section>

        <section id="features" className="landing-section landing-features" aria-labelledby="features-title">
          <div className="landing-section-heading">
            <span>CORE CAPABILITIES</span>
            <h2 id="features-title">从洞察到成片，一站完成</h2>
            <p>每项能力都围绕真实创作任务设计，分析结果可以自然进入下一步生成。</p>
          </div>
          <div className="landing-feature-grid">
            {features.map((feature, index) => (
              <article className="landing-feature-card" key={feature.title}>
                <div className="landing-feature-top"><span>0{index + 1}</span><feature.icon aria-hidden="true" /></div>
                <h3>{feature.title}</h3>
                <p>{feature.desc}</p>
                <button type="button" onClick={goToWorkspace}>立即体验 <ChevronRight aria-hidden="true" /></button>
              </article>
            ))}
          </div>
        </section>

        <section id="workflow" className="landing-section landing-workflow" aria-labelledby="workflow-title">
          <div className="landing-section-heading">
            <span>HOW IT WORKS</span>
            <h2 id="workflow-title">把复杂创作，沉淀为三步</h2>
            <p>不需要学习新的复杂软件，从已有素材直接开始。</p>
          </div>
          <div className="landing-step-grid">
            {steps.map((item, index) => (
              <article className="landing-step-card" key={item.step}>
                <div className="landing-step-index">{item.step}</div>
                <div className="landing-step-icon"><item.icon aria-hidden="true" /></div>
                <h3>{item.title}</h3>
                <p>{item.desc}</p>
                {index < steps.length - 1 && <ArrowRight className="landing-step-arrow" aria-hidden="true" />}
              </article>
            ))}
          </div>
        </section>

        <section id="pricing" className="landing-section landing-pricing" aria-labelledby="pricing-title">
          <div className="landing-section-heading">
            <span>PRICING</span>
            <h2 id="pricing-title">按创作节奏，选择合适方案</h2>
            <p>透明的分析额度与生成费率，个人与团队都能从小规模开始。</p>
          </div>
          <div className="landing-price-grid">
            {tiers.map((tier) => (
              <article className={`landing-price-card ${tier.popular ? 'is-popular' : ''}`} key={tier.name}>
                {tier.popular && <div className="landing-popular-badge">推荐方案</div>}
                <p className="landing-price-desc">{tier.desc}</p>
                <h3>{tier.name}</h3>
                <div className="landing-price"><strong>{tier.price}</strong><span>{tier.period}</span></div>
                <ul>{tier.features.map((item) => <li key={item}><Check aria-hidden="true" /> {item}</li>)}</ul>
                <button type="button" className={tier.popular ? 'landing-primary-btn' : 'landing-plan-btn'} onClick={goToWorkspace}>
                  {tier.price === '联系我们' ? '了解企业方案' : '开始使用'}
                </button>
              </article>
            ))}
          </div>
        </section>

        <section id="faq" className="landing-section landing-faq" aria-labelledby="faq-title">
          <div className="landing-faq-intro">
            <span>FAQ</span>
            <h2 id="faq-title">开始前，你可能想知道</h2>
            <p>仍有疑问？登录工作台后可通过页面左下角联系客服。</p>
          </div>
          <div className="landing-faq-list">
            {faqs.map((item, index) => (
              <details key={item.q} open={index === 0}>
                <summary>{item.q}<span aria-hidden="true">+</span></summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="landing-final-cta" aria-labelledby="final-cta-title">
          <div>
            <span>现在开始</span>
            <h2 id="final-cta-title">让每一条素材，都沉淀为下一次增长。</h2>
            <p>进入工作台，完成你的第一次 AI 创意分析。</p>
          </div>
          <button type="button" className="landing-primary-btn" onClick={goToWorkspace}>进入工作台 <ArrowRight aria-hidden="true" /></button>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-footer-brand"><span className="landing-brand-mark" aria-hidden="true"><Layers3 /></span><div><strong>短视频创意风暴</strong><small>AI CREATIVE STUDIO</small></div></div>
        <p>© 2026 短视频创意风暴 · 让创意有迹可循</p>
        <div><a href="#features">产品能力</a><a href="#pricing">方案定价</a><a href="#faq">常见问题</a></div>
      </footer>
    </div>
  );
}
