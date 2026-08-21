import { adminNavigation, adminNavigationStyles } from './admin-navigation.js'

export const dataSyncDashboardHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>历史数据同步 · Market Server</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;600;700&display=swap');
    :root { --ink:#e7f1ed; --muted:#82968f; --paper:#07110f; --card:rgba(13,27,23,.88); --line:rgba(151,199,183,.13); --green:#59d6ad; --mint:rgba(44,150,114,.18); --red:#ee806c; --amber:#e5b65e; --shadow:0 24px 60px rgba(0,0,0,.22); }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; color:var(--ink); font-family:"Noto Sans SC",sans-serif; background:radial-gradient(circle at 14% 5%,rgba(47,142,111,.16),transparent 30rem),radial-gradient(circle at 88% 74%,rgba(41,112,90,.10),transparent 30rem),var(--paper); }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background-image:linear-gradient(rgba(137,193,175,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(137,193,175,.025) 1px,transparent 1px); background-size:32px 32px; mask-image:linear-gradient(black,transparent 82%); }
    ${adminNavigationStyles}
    .shell { position:relative; width:min(1180px,calc(100% - 40px)); margin:auto; padding:48px 0 64px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; margin-bottom:28px; }
    .eyebrow { color:var(--green); font:500 12px "DM Mono",monospace; letter-spacing:.16em; margin-bottom:12px; }
    h1 { margin:0; font-size:clamp(36px,5vw,58px); line-height:1; letter-spacing:-.045em; }
    .subtitle { color:var(--muted); line-height:1.7; max-width:620px; margin:15px 0 0; }
    .state-pill { padding:9px 13px; border-radius:99px; background:var(--mint); color:var(--green); font-size:12px; font-weight:700; white-space:nowrap; }
    .grid { display:grid; grid-template-columns:360px minmax(0,1fr); gap:14px; }
    .panel,.metric { background:var(--card); border:1px solid var(--line); box-shadow:var(--shadow); backdrop-filter:blur(18px); }
    .panel { border-radius:22px; overflow:hidden; animation:rise .55s both; }
    .form { padding:24px; }
    h2 { margin:0 0 5px; font-size:17px; }
    .note { color:var(--muted); font-size:12px; line-height:1.55; }
    .field { margin-top:20px; }
    label { display:block; color:var(--muted); font-size:12px; margin-bottom:8px; }
    input,select { width:100%; border:1px solid transparent; border-radius:11px; background:#13231d; padding:11px 12px; color:var(--ink); font:500 13px "DM Mono",monospace; outline:none; }
    input:focus,select:focus { border-color:var(--green); background:#172a22; }
    .checks { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .check { display:flex; align-items:center; gap:8px; padding:11px; border-radius:11px; background:#13231d; font-size:13px; }
    .check input { width:auto; accent-color:var(--green); }
    .dates { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    button { border:0; border-radius:11px; padding:12px 14px; cursor:pointer; font:700 13px "Noto Sans SC",sans-serif; transition:transform .18s,opacity .18s; }
    button:hover { transform:translateY(-1px); } button:disabled { opacity:.45; cursor:wait; transform:none; }
    .primary { width:100%; margin-top:22px; color:#07130f; background:var(--green); }
    .resume { width:100%; margin-top:8px; background:var(--mint); color:var(--green); }
    .cancel { width:100%; margin-top:8px; background:rgba(190,73,55,.14); color:var(--red); }
    .error { min-height:18px; margin-top:12px; color:var(--red); font-size:12px; }
    .content { padding:22px; }
    .metrics { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:16px; }
    .metric { padding:17px; border-radius:16px; box-shadow:none; }
    .metric-label { color:var(--muted); font-size:11px; margin-bottom:7px; }
    .metric-value { font:500 24px "DM Mono",monospace; }
    .run-card { border:1px solid var(--line); border-radius:17px; padding:20px; background:#10201b; }
    .run-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
    .run-title { font-weight:700; }
    .mono { font:400 11px "DM Mono",monospace; color:var(--muted); overflow-wrap:anywhere; }
    .progress-track { height:10px; border-radius:10px; background:#22342d; margin:20px 0 9px; overflow:hidden; }
    .progress { height:100%; width:0; border-radius:inherit; background:linear-gradient(90deg,var(--green),#5ba479); transition:width .35s; }
    .progress-line { display:flex; justify-content:space-between; color:var(--muted); font-size:12px; }
    .current { margin-top:18px; padding:13px 15px; border-radius:12px; background:#162821; }
    .current strong { display:block; margin-bottom:3px; font-size:13px; }
    .errors { margin-top:15px; }
    .error-row { border-top:1px solid var(--line); padding:10px 2px; font-size:12px; color:var(--red); }
    .storage { margin-top:15px; padding:16px 18px; border:1px solid var(--line); border-radius:15px; color:var(--muted); background:#10201b; font-size:12px; line-height:1.8; }
    .storage strong { color:var(--ink); }
    @keyframes rise { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
    @media(max-width:820px) { .grid{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}header{align-items:flex-start;flex-direction:column} }
    @media(max-width:520px) { .shell{width:calc(100% - 24px);padding-top:24px}.dates{grid-template-columns:1fr}.content{padding:14px}.metric-value{font-size:20px} }
  </style>
</head>
<body>
  ${adminNavigation('sync')}
  <main class="shell">
    <header>
      <div><div class="eyebrow">DAILY DATA PIPELINE</div><h1>历史数据同步</h1><p class="subtitle">将股票与指数日线写入本地 DuckDB。任务按标的串行执行，支持失败隔离和最近 10 天增量回补。</p></div>
      <div class="state-pill" id="state">正在连接</div>
    </header>
    <section class="grid">
      <aside class="panel form">
        <h2>创建同步任务</h2><div class="note">建议先用 10 个标的验证，再执行全量同步。</div>
        <div class="field"><label>标的分类</label><div class="checks"><label class="check"><input id="equity" type="checkbox" checked>股票</label><label class="check"><input id="index" type="checkbox" checked>指数</label></div></div>
        <div class="field"><label>日期范围</label><div class="dates"><input id="start" type="date" value="2025-01-01"><input id="end" type="date"></div></div>
        <div class="field"><label for="adjustment">复权方式</label><select id="adjustment"><option value="none">不复权（推荐原始库）</option><option value="forward">前复权</option><option value="backward">后复权</option></select></div>
        <div class="field"><label for="limit">同步范围</label><select id="limit"><option value="10">前 10 个 · 本地验证</option><option value="100">前 100 个</option><option value="1000">前 1000 个</option><option value="all">全部标的</option></select></div>
        <div class="field"><label for="delay">请求间隔</label><select id="delay"><option value="250">250 ms</option><option value="500">500 ms</option><option value="750" selected>750 ms · 推荐</option><option value="1000">1 秒</option><option value="2000">2 秒</option></select></div>
        <button class="primary" id="start-sync">开始同步</button><button class="resume" id="resume-sync" disabled>继续上次任务</button><button class="cancel" id="cancel-sync" disabled>取消任务</button><div class="error" id="error"></div>
      </aside>
      <article class="panel content">
        <div class="metrics"><div class="metric"><div class="metric-label">库内标的</div><div class="metric-value" id="instruments">—</div></div><div class="metric"><div class="metric-label">日线记录</div><div class="metric-value" id="bars">—</div></div><div class="metric"><div class="metric-label">成功标的</div><div class="metric-value" id="succeeded">—</div></div><div class="metric"><div class="metric-label">失败标的</div><div class="metric-value" id="failed">—</div></div></div>
        <div class="run-card" id="run"><div class="note">尚无同步任务</div></div>
        <div class="storage"><strong>本地仓库</strong><br><span id="database">—</span><br>数据覆盖：<span id="coverage">—</span></div>
      </article>
    </section>
  </main>
  <script>
    const byId=(id)=>document.getElementById(id); byId('end').value=new Date().toISOString().slice(0,10);
    const esc=(v)=>String(v).replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    const statusName={running:'同步中',completed:'已完成',completed_with_errors:'完成 · 有异常',cancelled:'已取消',failed:'失败'};
    async function request(url,options){const response=await fetch(url,options);const body=await response.json();if(!response.ok)throw new Error(body.detail||'请求失败');return body;}
    function renderRun(run,active){
      byId('succeeded').textContent=run?run.succeeded:'—'; byId('failed').textContent=run?run.failed:'—';
      if(!run){byId('run').innerHTML='<div class="note">尚无同步任务</div>';return;}
      const percent=run.total?Math.round(run.completed/run.total*100):100; const current=run.current_instrument;
      byId('run').innerHTML='<div class="run-head"><div><div class="run-title">'+esc(statusName[run.status]||run.status)+'</div><div class="mono">RUN '+esc(run.run_id)+'</div></div><div class="mono">写入 '+run.bars_written.toLocaleString()+' 条</div></div><div class="progress-track"><div class="progress" style="width:'+percent+'%"></div></div><div class="progress-line"><span>'+run.completed+' / '+run.total+' 个标的</span><span>'+percent+'%</span></div>'+(current?'<div class="current"><strong>'+esc(current.name)+' · '+esc(current.symbol)+'</strong><span class="mono">'+esc(current.instrument_id)+'</span></div>':'')+(run.errors.length?'<div class="errors">'+run.errors.slice(-5).map((error)=>'<div class="error-row">'+esc(error.symbol||'任务')+' · '+esc(error.message)+'</div>').join('')+'</div>':'');
      byId('state').textContent=active?'同步任务运行中':statusName[run.status]||run.status;
    }
    function render(body){const data=body.data;const active=data.active_run;const run=active||data.last_run;const resumable=!active&&run&&['cancelled','failed'].includes(run.status)&&run.completed<run.total;byId('instruments').textContent=data.storage.instruments.toLocaleString();byId('bars').textContent=data.storage.daily_bars.toLocaleString();byId('database').textContent=data.database_path;byId('coverage').textContent=data.storage.first_trading_date?(data.storage.first_trading_date+' → '+data.storage.last_trading_date):'暂无数据';byId('start-sync').disabled=!!active;byId('resume-sync').disabled=!resumable;byId('cancel-sync').disabled=!active;if(!active)byId('state').textContent=run?(statusName[run.status]||run.status):'待同步';renderRun(run,!!active);}
    async function refresh(){try{render(await request('/v1/data-sync'));byId('error').textContent='';}catch(error){byId('error').textContent=error.message;byId('state').textContent='连接异常';}}
    byId('start-sync').addEventListener('click',async()=>{const types=[];if(byId('equity').checked)types.push('equity');if(byId('index').checked)types.push('index');const limit=byId('limit').value;try{await request('/v1/data-sync/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({instrument_types:types,start:byId('start').value,end:byId('end').value,adjustment:byId('adjustment').value,delay_ms:Number(byId('delay').value),...(limit==='all'?{}:{limit:Number(limit)})})});await refresh();}catch(error){byId('error').textContent=error.message;}});
    byId('resume-sync').addEventListener('click',async()=>{try{await request('/v1/data-sync/resume',{method:'POST'});await refresh();}catch(error){byId('error').textContent=error.message;}});
    byId('cancel-sync').addEventListener('click',async()=>{try{await request('/v1/data-sync/cancel',{method:'POST'});await refresh();}catch(error){byId('error').textContent=error.message;}});
    refresh();setInterval(refresh,2500);
  </script>
</body>
</html>`
