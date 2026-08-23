const githubUrl = 'https://github.com/lengjinyang/Yoiniwa';
const releaseUrl = `${githubUrl}/releases`;

const features = [
  { index: '01', title: '无限画布，自由编排', text: '把零散灵感铺进同一片画布。拖入图片、缩放旋转、分组排列，让构图关系一眼可见。', tag: 'Canvas' },
  { index: '02', title: '不破坏原图的调整', text: '裁剪、翻转、透明度、灰度与对比度都可随时回退。参考素材始终保留原始状态。', tag: 'Non-destructive' },
  { index: '03', title: '贴近 Photoshop 的工作流', text: '直接从参考图原始像素取色，并同步至 Photoshop 前景色，让观察与落笔保持连贯。', tag: 'Photoshop' },
];

const workflow = [
  ['01', '收集', '拖入文件、粘贴截图，或导入网络图片。'],
  ['02', '整理', '对齐、分组、标注，把杂乱素材变成清晰画板。'],
  ['03', '创作', '保持置顶、快速取色，在创作软件中专注落笔。'],
];

export default function Home() {
  return (
    <main>
      <nav className="nav shell" aria-label="主导航">
        <a className="brand" href="#top" aria-label="Yoiniwa 首页"><img src="./yoiniwa-icon.png" alt="" /><span>Yoiniwa</span><em>宵庭</em></a>
        <div className="nav-links"><a href="#features">功能</a><a href="#workflow">工作流</a><a href="#privacy">隐私</a></div>
        <a className="nav-cta" href={githubUrl} target="_blank" rel="noreferrer">GitHub <span>↗</span></a>
      </nav>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span /> 为视觉创作者而生</div>
          <h1>把灵感，<br />留在<span>画布</span>上。</h1>
          <p>Yoiniwa 是一款面向插画与视觉创作的 Windows 参考图画板。自由收集、整理与观察素材，让注意力回到创作本身。</p>
          <div className="hero-actions">
            <a className="button button-primary" href={releaseUrl} target="_blank" rel="noreferrer">下载 Windows 版 <span>→</span></a>
            <a className="button button-ghost" href={githubUrl} target="_blank" rel="noreferrer">查看源代码</a>
          </div>
          <div className="hero-meta"><span><i /> Windows 10 / 11</span><span>本地存储</span><span>无需登录</span></div>
        </div>

        <div className="canvas-showcase" aria-label="Yoiniwa 参考画板界面概念展示">
          <div className="canvas-glow" />
          <div className="app-window">
            <div className="titlebar"><div className="window-brand"><img src="./yoiniwa-icon.png" alt="" /> Yoiniwa</div><div className="window-controls"><span /><span /><span /></div></div>
            <div className="board">
              <div className="board-grid" />
              <div className="card card-a"><span className="card-label">COLOR / 01</span></div>
              <div className="card card-b"><span className="card-label">LIGHT / 02</span></div>
              <div className="card card-c"><span className="card-label">FORM / 03</span></div>
              <div className="selected-frame"><i /><i /><i /><i /></div>
              <div className="note">soft light<br /><b>+ cool shadow</b></div>
              <div className="palette"><span /><span /><span /><span /><span /></div>
              <div className="zoom">84%</div>
            </div>
          </div>
          <div className="floating-badge badge-top"><b>∞</b><span>无限画布<br /><small>自由缩放与漫游</small></span></div>
          <div className="floating-badge badge-bottom"><b>⌁</b><span>顺滑取色<br /><small>衔接 Photoshop</small></span></div>
        </div>
      </section>

      <section className="statement"><div className="marquee" aria-hidden="true"><span>COLLECT</span><i>✦</i><span>ARRANGE</span><i>✦</i><span>CREATE</span><i>✦</i><span>YOINIWA</span></div></section>

      <section className="section shell" id="features">
        <div className="section-head"><div><span className="kicker">核心能力</span><h2>从参考，到创作。<br />少一点打断。</h2></div><p>不堆叠复杂流程，只把创作者每天真正需要的动作做得更自然。</p></div>
        <div className="feature-grid">
          {features.map((feature) => (
            <article className="feature-card" key={feature.index}>
              <div className={`feature-visual visual-${feature.index}`}>
                <span className="feature-number">{feature.index}</span>
                {feature.index === '01' && <><i className="tile t1" /><i className="tile t2" /><i className="tile t3" /></>}
                {feature.index === '02' && <><i className="crop crop-a" /><i className="crop crop-b" /><span className="crop-line" /></>}
                {feature.index === '03' && <><i className="color-ring" /><i className="color-center" /><span className="color-code">#8E7CFF</span></>}
              </div>
              <div className="feature-body"><span className="feature-tag">{feature.tag}</span><h3>{feature.title}</h3><p>{feature.text}</p></div>
            </article>
          ))}
        </div>
      </section>

      <section className="workflow-wrap" id="workflow"><div className="section shell">
        <div className="workflow-intro"><span className="kicker light">创作节奏</span><h2>三步，把参考素材<br />变成你的视觉语境。</h2></div>
        <div className="workflow-list">{workflow.map(([number,title,text]) => <div className="workflow-row" key={number}><span>{number}</span><h3>{title}</h3><p>{text}</p><i>↗</i></div>)}</div>
      </div></section>

      <section className="privacy shell" id="privacy"><div className="privacy-card">
        <div className="privacy-mark"><span>LOCAL</span><b>你的素材<br />只属于你。</b></div>
        <div className="privacy-copy"><span className="kicker">本地优先</span><h2>不上传，不追踪，<br />也不要求登录。</h2><p>工程与图片默认保存在本地。Yoiniwa 不包含遥测上报，离线也能完成从整理到导出的完整工作。</p><div className="privacy-pills"><span>本地工程</span><span>零遥测</span><span>.yoi 格式</span></div></div>
      </div></section>

      <section className="cta shell"><div className="cta-orbit orbit-one" /><div className="cta-orbit orbit-two" /><img src="./yoiniwa-icon.png" alt="Yoiniwa 图标" /><span className="kicker light">开始创作</span><h2>给灵感一个安静的庭院。</h2><p>免费下载，适用于 Windows 10 / 11 x64。</p><a className="button button-light" href={releaseUrl} target="_blank" rel="noreferrer">前往 Releases 下载 <span>→</span></a></section>

      <footer className="footer shell"><a className="brand" href="#top"><img src="./yoiniwa-icon.png" alt="" /><span>Yoiniwa</span><em>宵庭</em></a><p>为插画与视觉创作者打造的参考图画板。</p><div><a href={githubUrl} target="_blank" rel="noreferrer">GitHub ↗</a><a href={`${githubUrl}/issues`} target="_blank" rel="noreferrer">反馈问题 ↗</a></div><small>© 2026 Yoiniwa. Independent project.</small></footer>
    </main>
  );
}
