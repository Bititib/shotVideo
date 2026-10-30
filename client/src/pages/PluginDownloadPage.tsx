import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownToLine, ArrowUpRight, Download, RefreshCw } from 'lucide-react';
import './PluginDownloadPage.css';

type Release = { version: string; archive: string; notes: string };

export default function PluginDownloadPage() {
  const [release, setRelease] = useState<Release | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), 15000);
    setRelease(null); setError(false);
    (async () => {
      const response = await fetch('/plugin-updates/video_plugin_site_api/latest.json', {
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) throw new Error('Release unavailable');
      const data = await response.json();
      if (data?.schema_version !== 1 || data.plugin_id !== 'video_plugin_site_api'
        || typeof data.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(data.version)
        || data.archive !== `/plugin-updates/video_plugin_site_api/lingxu-video-${data.version}.zip`) throw new Error('Invalid release');
      if (active) setRelease({ version: data.version, archive: data.archive, notes: typeof data.notes === 'string' ? data.notes.slice(0, 2000) : '' });
    })().catch(() => { if (active) setError(true); }).finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [revision]);

  return <div className="plugin-download-page">
    <header className="plugin-download-heading"><p>字字动画 · 视频生成</p><h1>灵序 AI 视频插件</h1><span>在字字动画里选模型、填提示词、生成视频，完成后自动取回结果。</span></header>
    <section className="plugin-release" aria-label="插件下载">
      <div className="plugin-release-icon" aria-hidden="true"><Download size={26} /></div>
      <div className="plugin-release-content"><h2>Windows 安装包 {release && <span>v{release.version}</span>}</h2>
        <p>下载无需登录。使用时填写自己的灵序 AI API Key。</p>
        {release ? <><a className="plugin-download-button" href={release.archive} download={`灵序AI视频插件-${release.version}.zip`}><ArrowDownToLine size={18} />下载插件 v{release.version}</a>
          {release.notes && <p className="plugin-release-notes">{release.notes}</p>}</>
          : error ? <div role="alert"><p>暂时无法获取最新版本，请稍后重试。</p><button className="plugin-retry" onClick={() => setRevision(v => v + 1)}><RefreshCw size={15} />重新获取版本</button></div>
          : <p role="status">正在获取最新版本…</p>}
        <nav className="plugin-guide-links" aria-label="安装帮助"><a href="#plugin-install">首次安装</a><a href="#plugin-update">已有插件更新</a><Link to="/app/profile">创建 API Key<ArrowUpRight size={14} /></Link></nav>
      </div>
    </section>
    <div className="plugin-guides">
      <section id="plugin-install"><h2><span>01</span>首次安装</h2><ol>
        <li>下载并解压，得到 <code>video_plugin_site_api</code> 文件夹。保存作品，彻底退出字字动画。</li>
        <li>将整个文件夹放入字字动画安装目录下的：<code className="plugin-install-path">_internal\user_resources\plugins\video_plugins\</code>
          最终应能找到 <code>video_plugins\video_plugin_site_api\main.py</code>，不要多套一层同名文件夹。</li>
        <li>重新打开字字动画，进入作品 → 视频模型管理 → 自定义插件，选择「灵序 AI 视频插件」。</li>
        <li>在<Link to="/app/profile">网站个人中心</Link>创建自己的 API Key，填入插件「网站连接」，点击「连接并获取模型」。</li>
        <li>选择模型和参数，应用设置；回到分镜填写视频提示词、添加参考素材，点击「生成视频」。</li>
      </ol><p className="plugin-guide-note">以上路径适用于已验证的 Windows 安装包；若没有 _internal 文件夹，请先确认当前字字动画版本的插件目录。</p></section>
      <section id="plugin-update"><h2><span>02</span>已有插件更新</h2><ol>
        <li>先处理完生成、取回及待核实任务。</li>
        <li>打开插件的「插件更新」。1.1.0／1.1.1 在面板底部；1.1.2 起在最上方。</li>
        <li>点击「检查更新」，发现新版后点击升级。</li>
        <li>安装成功后保存作品，彻底退出并重新打开字字动画。</li>
      </ol><p className="plugin-guide-note">自动检查新版，安装由你点击确认。远程升级保留 API Key、用户设置和任务记录。</p>
        <details><summary>旧版没有更新入口，怎么办？</summary><p>下载完整安装包，退出字字动画后备份原插件文件夹，再覆盖同名程序文件。保留原有 <code>config.json</code> 和 <code>.state</code>，不要删除整个旧插件目录或用户配置目录。1.0.x 手动升级一次后，即可使用在线更新。</p></details>
        <details><summary>生成完成后，在分镜里没看到结果？</summary><p>打开「任务记录与取回」，查询并取回原任务，再在作品中使用「找回未记录的生成结果」。不要为了取回结果重复点击生成。</p></details>
      </section>
    </div>
    <p className="plugin-download-footnote">安装包不包含 API Key。生成需有对应模型权限和足够余额，费用以网站显示为准。请只分享干净安装包，不要分享自己的密钥、配置或任务记录。</p>
  </div>;
}
