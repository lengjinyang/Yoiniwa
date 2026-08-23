'use client';

import { useEffect, useState } from 'react';

const githubUrl = 'https://github.com/lengjinyang/Yoiniwa';
const releaseUrl = `${githubUrl}/releases`;

const copy = {
  zh: {
    pageTitle: 'Yoiniwa 宵庭｜视觉创作者的参考图画板',
    navLabel: '主导航', homeLabel: 'Yoiniwa 首页', nav: ['功能', '工作流', '视频'], eyebrow: '为视觉创作者而生',
    heroLine1: '把灵感，', heroLine2: '留在', heroAccent: '画布', heroEnd: '上。', heroText: '面向插画与视觉创作的 Windows 参考图画板。自由收集、整理与观察素材。',
    download: '下载 Windows 版', repository: '查看项目仓库', local: '本地存储', noLogin: '无需登录', showcase: 'Yoiniwa 参考画板界面概念展示',
    featureKicker: '核心能力', featureTitle: <>从参考，到创作。<br />少一点打断。</>, featureIntro: '把常用动作留在画布里，让观察与创作保持连贯。',
    features: [
      { index: '01', title: '无限画布，自由编排', text: '拖入图片，自由缩放、旋转与分组，让素材关系一眼可见。', tag: 'Canvas' },
      { index: '02', title: '不破坏原图的调整', text: '裁剪、翻转与色彩调整随时可回退，原始素材始终保留。', tag: 'Non-destructive' },
      { index: '03', title: '连接 Photoshop', text: '读取参考图原始像素，并同步到 Photoshop 前景色。', tag: 'Photoshop' },
    ],
    workflowKicker: '创作节奏', workflowTitle: <>三步，把参考素材<br />变成你的视觉语境。</>,
    workflow: [['01', '收集', '拖入文件、粘贴截图，或导入网络图片。'], ['02', '整理', '对齐、分组、标注，把杂乱素材变成清晰画板。'], ['03', '创作', '保持置顶、快速取色，在创作软件中专注落笔。']],
    videoCaption: <>静止画之外，<br />也收藏流动的瞬间。</>, videoKicker: '视频参考', videoTitle: <>让动态参考，<br />停在需要观察的一帧。</>, videoText: '视频与图片在同一画布中自由编排，随时播放或暂停。', videoPills: ['画布内播放', '暂停观察', '自由编排'],
    ctaKicker: '开始创作', ctaTitle: '给灵感一个安静的庭院。', ctaText: '免费下载，适用于 Windows 10 / 11 x64。', ctaButton: '前往 Releases 下载',
    footer: '为插画与视觉创作者打造的参考图画板。', feedback: '反馈问题', iconAlt: 'Yoiniwa 图标',
  },
  en: {
    pageTitle: 'Yoiniwa | Reference Board for Visual Creators',
    navLabel: 'Main navigation', homeLabel: 'Yoiniwa home', nav: ['Features', 'Workflow', 'Video'], eyebrow: 'Made for visual creators',
    heroLine1: 'Keep inspiration', heroLine2: 'on your ', heroAccent: 'canvas', heroEnd: '.', heroText: 'A Windows reference board for illustration and visual creation. Collect, arrange, and observe freely.',
    download: 'Download for Windows', repository: 'View repository', local: 'Local storage', noLogin: 'No sign-in', showcase: 'Yoiniwa reference board concept preview',
    featureKicker: 'Core features', featureTitle: <>From reference to creation.<br />With fewer interruptions.</>, featureIntro: 'Keep essential actions on the canvas and your creative flow uninterrupted.',
    features: [
      { index: '01', title: 'Infinite canvas, free arrangement', text: 'Drop in images, then scale, rotate, and group them to reveal visual relationships.', tag: 'Canvas' },
      { index: '02', title: 'Non-destructive adjustments', text: 'Crop, flip, and tune colors while keeping the original material intact.', tag: 'Non-destructive' },
      { index: '03', title: 'Connected to Photoshop', text: 'Sample original pixels and sync them directly to the Photoshop foreground color.', tag: 'Photoshop' },
    ],
    workflowKicker: 'Creative rhythm', workflowTitle: <>Three steps from references<br />to your visual language.</>,
    workflow: [['01', 'Collect', 'Drop files, paste screenshots, or import images from the web.'], ['02', 'Arrange', 'Align, group, and label material into a clear reference board.'], ['03', 'Create', 'Stay on top, sample colors quickly, and focus on making.']],
    videoCaption: <>Beyond still images,<br />capture moments in motion.</>, videoKicker: 'Video reference', videoTitle: <>Pause motion<br />at the frame you need.</>, videoText: 'Arrange videos and images on one canvas, then play or pause whenever needed.', videoPills: ['Play on canvas', 'Pause to observe', 'Arrange freely'],
    ctaKicker: 'Start creating', ctaTitle: 'Give inspiration a quiet garden.', ctaText: 'Free download for Windows 10 / 11 x64.', ctaButton: 'Download from Releases',
    footer: 'A reference board for illustrators and visual creators.', feedback: 'Report an issue', iconAlt: 'Yoiniwa icon',
  },
};

type Language = keyof typeof copy;

export default function Home() {
  const [language, setLanguage] = useState<Language>('zh');
  const t = copy[language];

  useEffect(() => {
    const saved = window.localStorage.getItem('yoiniwa-language');
    const detected: Language = saved === 'zh' || saved === 'en' ? saved : navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    setLanguage(detected);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.title = t.pageTitle;
  }, [language, t.pageTitle]);

  const switchLanguage = () => {
    const next: Language = language === 'zh' ? 'en' : 'zh';
    setLanguage(next);
    window.localStorage.setItem('yoiniwa-language', next);
  };

  return (
    <main>
      <nav className="nav shell" aria-label={t.navLabel}>
        <a className="brand" href="#top" aria-label={t.homeLabel}><img src="./yoiniwa-icon.png" alt="" /><span>Yoiniwa</span><em>宵庭</em></a>
        <div className="nav-links"><a href="#features">{t.nav[0]}</a><a href="#workflow">{t.nav[1]}</a><a href="#video">{t.nav[2]}</a></div>
        <div className="nav-actions"><button className="language-toggle" type="button" onClick={switchLanguage} aria-label={language === 'zh' ? 'Switch to English' : '切换到中文'}>{language === 'zh' ? 'EN' : '中文'}</button><a className="nav-cta" href={githubUrl} target="_blank" rel="noreferrer">GitHub <span>↗</span></a></div>
      </nav>

      <section className="hero shell" id="top">
        <div className="hero-copy"><div className="eyebrow"><span /> {t.eyebrow}</div><h1>{t.heroLine1}<br />{t.heroLine2}<span>{t.heroAccent}</span>{t.heroEnd}</h1><p>{t.heroText}</p><div className="hero-actions"><a className="button button-primary" href={releaseUrl} target="_blank" rel="noreferrer">{t.download} <span>→</span></a><a className="button button-ghost" href={githubUrl} target="_blank" rel="noreferrer">{t.repository}</a></div><div className="hero-meta"><span><i /> Windows 10 / 11 x64</span><span>{t.local}</span><span>{t.noLogin}</span></div></div>
        <div className="canvas-showcase" aria-label={t.showcase}><div className="canvas-glow" /><div className="app-window"><div className="titlebar"><div className="window-brand"><img src="./yoiniwa-icon.png" alt="" /> Yoiniwa · untitled.yoi</div><div className="window-controls"><span /><span /><span /></div></div><div className="board"><div className="board-grid" /><div className="support-art support-art-left" aria-hidden="true"><img src="./board-artwork-botanical.png" alt="" /></div><div className="support-art support-art-right" aria-hidden="true"><img src="./board-artwork-material.png" alt="" /></div><div className="board-artwork" aria-hidden="true" style={{ position: 'absolute', width: '58%', height: '44%', left: '21%', top: '27%', overflow: 'hidden', border: '6px solid #f1eee8', background: '#263547', boxShadow: '0 20px 40px rgba(0,0,0,.38)', transform: 'rotate(-2.5deg) translateZ(0)', backfaceVisibility: 'hidden', zIndex: 3 }}><img src="./board-artwork.png" alt="" /></div><div className="palette"><span /><span /><span /><span /><span /></div><div className="zoom">84%</div></div></div></div>
      </section>

      <section className="features-wrap" id="features"><div className="section shell"><div className="section-head"><div><span className="kicker">{t.featureKicker}</span><h2>{t.featureTitle}</h2></div><p>{t.featureIntro}</p></div><div className="feature-grid">{t.features.map((feature) => <article className="feature-card" key={feature.index}><div className={`feature-visual visual-${feature.index}`}><span className="feature-number">{feature.index}</span>{feature.index === '01' && <><i className="tile t1" /><i className="tile t2" /><i className="tile t3" /></>}{feature.index === '02' && <><i className="crop crop-a" /><i className="crop crop-b" /><span className="crop-line" /></>}{feature.index === '03' && <><i className="color-ring" /><i className="color-center" /><span className="color-code">#71849C</span></>}</div><div className="feature-body"><span className="feature-tag">{feature.tag}</span><h3>{feature.title}</h3><p>{feature.text}</p></div></article>)}</div></div></section>

      <section className="workflow-wrap" id="workflow"><div className="section shell"><div className="workflow-intro"><span className="kicker light">{t.workflowKicker}</span><h2>{t.workflowTitle}</h2></div><div className="workflow-list">{t.workflow.map(([number, title, text]) => <div className="workflow-row" key={number}><span>{number}</span><h3>{title}</h3><p>{text}</p><i>↗</i></div>)}</div></div></section>

      <section className="video-section shell" id="video"><div className="video-card"><div className="video-visual" aria-hidden="true"><span className="video-label">VIDEO REFERENCE / 04</span><div className="video-frame"><i className="video-shape shape-one" /><i className="video-shape shape-two" /><i className="video-play">▶</i><div className="video-timeline"><span /></div><small>00:18 / 01:24</small></div><b>{t.videoCaption}</b></div><div className="video-copy"><span className="kicker">{t.videoKicker}</span><h2>{t.videoTitle}</h2><p>{t.videoText}</p><div className="video-pills">{t.videoPills.map((pill) => <span key={pill}>{pill}</span>)}</div></div></div></section>

      <section className="cta shell"><div className="cta-orbit orbit-one" /><div className="cta-orbit orbit-two" /><img src="./yoiniwa-icon.png" alt={t.iconAlt} /><span className="kicker light">{t.ctaKicker}</span><h2>{t.ctaTitle}</h2><p>{t.ctaText}</p><a className="button button-light" href={releaseUrl} target="_blank" rel="noreferrer">{t.ctaButton} <span>→</span></a></section>

      <footer className="footer shell"><a className="brand" href="#top"><img src="./yoiniwa-icon.png" alt="" /><span>Yoiniwa</span><em>宵庭</em></a><p>{t.footer}</p><div><a href={githubUrl} target="_blank" rel="noreferrer">GitHub ↗</a><a href={`${githubUrl}/issues`} target="_blank" rel="noreferrer">{t.feedback} ↗</a></div><small>© 2026 Yoiniwa. Independent project.</small></footer>
    </main>
  );
}
