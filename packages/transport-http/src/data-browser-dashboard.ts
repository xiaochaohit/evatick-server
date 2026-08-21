import { adminNavigation, adminNavigationStyles } from './admin-navigation.js'

export const dataBrowserDashboardHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>数据浏览 · EVA</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;600;700&display=swap');
    :root { --ink:#e7f1ed; --muted:#82968f; --paper:#07110f; --card:rgba(13,27,23,.9); --line:rgba(151,199,183,.13); --green:#59d6ad; --red:#ee806c; --shadow:0 24px 60px rgba(0,0,0,.22); }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; color:var(--ink); font-family:"Noto Sans SC",sans-serif; background:radial-gradient(circle at 14% 5%,rgba(47,142,111,.16),transparent 30rem),radial-gradient(circle at 88% 74%,rgba(41,112,90,.10),transparent 30rem),var(--paper); }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background-image:linear-gradient(rgba(137,193,175,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(137,193,175,.025) 1px,transparent 1px); background-size:32px 32px; mask-image:linear-gradient(black,transparent 82%); }
    ${adminNavigationStyles}
    .shell { position:relative; width:min(1180px,calc(100% - 40px)); margin:auto; padding:48px 0 70px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; margin-bottom:28px; }
    .eyebrow { color:var(--green); font:500 12px "DM Mono",monospace; letter-spacing:.16em; margin-bottom:12px; }
    h1 { margin:0; font-size:clamp(36px,5vw,58px); line-height:1; letter-spacing:-.045em; }
    .subtitle { color:var(--muted); line-height:1.7; max-width:650px; margin:15px 0 0; }
    .warehouse { color:var(--green); font:500 12px "DM Mono",monospace; white-space:nowrap; }
    .panel { border:1px solid var(--line); border-radius:22px; background:var(--card); box-shadow:var(--shadow); overflow:hidden; backdrop-filter:blur(18px); animation:rise .5s both; }
    .toolbar { display:flex; align-items:center; gap:12px; padding:18px 20px; border-bottom:1px solid var(--line); }
    .search { position:relative; flex:1; }
    .search::before { content:"⌕"; position:absolute; left:14px; top:9px; color:var(--green); font:18px "DM Mono",monospace; }
    input { width:100%; padding:11px 14px 11px 40px; color:var(--ink); background:#13231d; border:1px solid transparent; border-radius:11px; outline:none; font:500 13px "DM Mono",monospace; }
    input:focus { border-color:var(--green); background:#172a22; }
    .filters { display:flex; gap:4px; padding:4px; border-radius:12px; background:#10201b; }
    button { border:0; border-radius:9px; padding:9px 12px; color:var(--muted); background:transparent; cursor:pointer; font:600 12px "Noto Sans SC",sans-serif; }
    button:hover { color:var(--ink); } button:disabled { opacity:.35; cursor:not-allowed; }
    .filter.active { color:var(--green); background:#1b3028; }
    .table-wrap { overflow-x:auto; }
    table { width:100%; border-collapse:collapse; }
    th { padding:12px 18px; color:#60776e; text-align:left; font:500 10px "DM Mono",monospace; letter-spacing:.08em; border-bottom:1px solid var(--line); }
    td { padding:15px 18px; border-bottom:1px solid rgba(151,199,183,.08); font-size:12px; white-space:nowrap; }
    tbody tr { cursor:pointer; transition:background .18s; } tbody tr:hover { background:rgba(89,214,173,.045); }
    .identity { min-width:180px; white-space:normal; }
    .identity strong { display:block; font-size:14px; margin-bottom:3px; }
    .mono { color:var(--muted); font:500 11px "DM Mono",monospace; }
    .type { display:inline-block; padding:4px 7px; color:#07130f; background:var(--green); border-radius:6px; font-size:10px; font-weight:700; }
    .number { font:500 12px "DM Mono",monospace; }
    .empty { padding:60px 20px; text-align:center; color:var(--muted); }
    .pager { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 20px; color:var(--muted); font-size:12px; }
    .pager-actions { display:flex; gap:7px; } .pager-actions button { background:#15251f; }
    .detail { display:none; margin-top:14px; }
    .detail.visible { display:block; }
    .detail-head { display:flex; align-items:flex-start; justify-content:space-between; padding:20px 22px; border-bottom:1px solid var(--line); }
    .detail-title { font-size:18px; font-weight:700; } .detail-note { margin-top:4px; }
    .close { background:#15251f; }
    .positive { color:var(--green); } .negative { color:var(--red); }
    .health { margin-top:14px; }
    .health-head { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:20px 22px; border-bottom:1px solid var(--line); }
    .health-title { font-size:17px; font-weight:700; } .health-subtitle { margin-top:4px; color:var(--muted); font-size:12px; }
    .health-actions { display:flex; align-items:center; gap:8px; }
    select { padding:9px 30px 9px 11px; color:var(--ink); background:#15251f; border:1px solid var(--line); border-radius:9px; outline:none; }
    .health-actions button { background:#15251f; } .health-actions .check-now { color:#07130f; background:var(--green); }
    .source-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:1px; background:var(--line); }
    .source-card { display:grid; grid-template-columns:1fr auto; gap:8px; padding:16px 20px; background:#0d1b17; }
    .source-name { font-weight:700; font-size:13px; } .source-meta { margin-top:4px; color:var(--muted); font:500 10px "DM Mono",monospace; }
    .source-status { align-self:center; padding:5px 8px; border-radius:7px; color:var(--muted); background:#172720; font-size:10px; font-weight:700; }
    .source-status.healthy { color:var(--green); background:rgba(44,150,114,.16); } .source-status.unhealthy { color:var(--red); background:rgba(190,73,55,.14); }
    @keyframes rise { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
    @media(max-width:760px) { .toolbar{align-items:stretch;flex-direction:column}.filters button{flex:1}.filters{width:100%}header{align-items:flex-start;flex-direction:column}.warehouse{white-space:normal}.hide-mobile{display:none}.health-head{align-items:flex-start;flex-direction:column}.health-actions{width:100%;flex-wrap:wrap}.health-actions select{flex:1}.source-grid{grid-template-columns:1fr} }
    @media(max-width:520px) { .shell{width:calc(100% - 24px);padding-top:32px}th,td{padding:12px}.identity{min-width:145px}.pager{align-items:flex-start;flex-direction:column}.pager-actions{width:100%}.pager-actions button{flex:1} }
  </style>
</head>
<body>
  ${adminNavigation('home')}
  <main class="shell">
    <header>
      <div><div class="eyebrow">EVA LOCAL WAREHOUSE</div><h1>数据浏览</h1><p class="subtitle">搜索本地 DuckDB 中已落库的股票与指数，检查日线覆盖范围、记录数量和最近行情。</p></div>
      <div class="warehouse" id="warehouse">正在连接本地仓库</div>
    </header>
    <section class="panel">
      <div class="toolbar">
        <div class="search"><input id="query" type="search" placeholder="输入代码或名称，例如 000001、平安银行、沪深 300" autocomplete="off"></div>
        <div class="filters" id="filters"><button class="filter active" data-type="">全部</button><button class="filter" data-type="equity">股票</button><button class="filter" data-type="index">指数</button></div>
      </div>
      <div class="table-wrap" id="list"><div class="empty">正在读取库内标的…</div></div>
      <div class="pager"><span id="summary">—</span><div class="pager-actions"><button id="previous" disabled>上一页</button><button id="next" disabled>下一页</button></div></div>
    </section>
    <section class="panel detail" id="detail">
      <div class="detail-head"><div><div class="detail-title" id="detail-title">—</div><div class="detail-note mono" id="detail-id">—</div></div><button class="close" id="close-detail">关闭</button></div>
      <div class="table-wrap" id="bars"><div class="empty">请选择一个标的</div></div>
    </section>
    <section class="panel health" id="data-sources">
      <div class="health-head"><div><div class="health-title">数据源健康</div><div class="health-subtitle" id="health-summary">作为辅助监控，按股票与指数检查远程上游可用性</div></div><div class="health-actions"><select id="health-interval"><option value="3600">每 1 小时</option><option value="10800">每 3 小时</option><option value="21600">每 6 小时</option><option value="43200">每 12 小时</option><option value="86400">每 24 小时</option></select><button id="save-health">保存周期</button><button class="check-now" id="check-health">立即检查</button></div></div>
      <div class="source-grid" id="health-list"><div class="empty">正在读取数据源状态…</div></div>
    </section>
  </main>
  <script>
    const byId=(id)=>document.getElementById(id);const esc=(v)=>String(v).replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    const state={query:'',type:'',offset:0,limit:30,total:0};let timer;
    async function request(url,options){const response=await fetch(url,options);const body=await response.json();if(!response.ok)throw new Error(body.detail||'请求失败');return body;}
    function formatNumber(value){return Number(value).toLocaleString('zh-CN');}
    function table(items){if(!items.length)return '<div class="empty">没有找到已落库的标的</div>';return '<table><thead><tr><th>标的</th><th>类型</th><th>市场</th><th>日线记录</th><th>数据覆盖</th><th>最新收盘</th></tr></thead><tbody>'+items.map((item)=>'<tr data-id="'+esc(item.instrument_id)+'" data-label="'+esc(item.name+' · '+item.symbol)+'"><td class="identity"><strong>'+esc(item.name)+'</strong><span class="mono">'+esc(item.symbol)+'</span></td><td><span class="type">'+(item.instrument_type==='equity'?'股票':'指数')+'</span></td><td class="mono">'+esc(item.venue||item.publisher||'—')+'</td><td class="number">'+formatNumber(item.records)+'</td><td class="mono hide-mobile">'+esc(item.first_trading_date)+' → '+esc(item.last_trading_date)+'</td><td class="number">'+esc(item.latest_close)+'</td></tr>').join('')+'</tbody></table>';}
    async function load(){const params=new URLSearchParams({limit:String(state.limit),offset:String(state.offset)});if(state.query)params.set('q',state.query);if(state.type)params.set('type',state.type);try{const body=await request('/v1/local-data/instruments?'+params);state.total=body.page.total;byId('list').innerHTML=table(body.data);const from=state.total?state.offset+1:0;const to=Math.min(state.offset+state.limit,state.total);byId('summary').textContent='显示 '+from+'–'+to+' / 共 '+formatNumber(state.total)+' 个标的';byId('previous').disabled=state.offset===0;byId('next').disabled=state.offset+state.limit>=state.total;byId('warehouse').textContent=formatNumber(body.meta.storage.daily_bars)+' 条日线 · '+formatNumber(body.meta.storage.instruments)+' 个标的';bindRows();}catch(error){byId('list').innerHTML='<div class="empty">'+esc(error.message)+'</div>';}}
    function bindRows(){document.querySelectorAll('tbody tr[data-id]').forEach((row)=>row.addEventListener('click',()=>openDetail(row.dataset.id,row.dataset.label)));}
    const healthLabels={healthy:'健康',unhealthy:'异常',checking:'检测中',unknown:'未检测'};
    function renderHealth(body){const sources=body.data.filter((source)=>source.source_id!=='local');const healthy=sources.filter((source)=>source.status==='healthy').length;byId('health-summary').textContent='远程检测项 '+sources.length+' · 健康 '+healthy+' · '+(body.schedule.enabled?'每 '+Math.round(body.schedule.interval_seconds/3600)+' 小时自动检查':'自动检查已停用');if(body.schedule.enabled)byId('health-interval').value=String(body.schedule.interval_seconds);byId('health-list').innerHTML=sources.map((source)=>'<div class="source-card"><div><div class="source-name">'+esc(source.source_name)+' · '+(source.category==='equity'?'股票':'指数')+'</div><div class="source-meta">'+esc(source.source_id)+' · '+(source.latency_ms===null?'—':source.latency_ms+' ms')+'</div></div><span class="source-status '+source.status+'">'+healthLabels[source.status]+'</span></div>').join('')||'<div class="empty">暂无远程数据源</div>';}
    async function loadHealth(){try{renderHealth(await request('/v1/data-sources'));}catch(error){byId('health-summary').textContent=error.message;}}
    async function openDetail(id,label){byId('detail').classList.add('visible');byId('detail-title').textContent=label;byId('detail-id').textContent=id;byId('bars').innerHTML='<div class="empty">正在读取最近日线…</div>';byId('detail').scrollIntoView({behavior:'smooth',block:'start'});try{const body=await request('/v1/local-data/instruments/'+encodeURIComponent(id)+'/bars?limit=20');const rows=body.data;byId('bars').innerHTML=rows.length?'<table><thead><tr><th>交易日</th><th>开盘</th><th>最高</th><th>最低</th><th>收盘</th><th>成交量</th><th>成交额</th></tr></thead><tbody>'+rows.map((bar)=>{const move=Number(bar.close)-Number(bar.open);return '<tr><td class="mono">'+esc(bar.trading_date)+'</td><td>'+esc(bar.open)+'</td><td>'+esc(bar.high)+'</td><td>'+esc(bar.low)+'</td><td class="number '+(move>=0?'positive':'negative')+'">'+esc(bar.close)+'</td><td class="number">'+(bar.volume===null?'—':formatNumber(bar.volume))+'</td><td class="number">'+(bar.turnover===null?'—':formatNumber(Math.round(Number(bar.turnover))))+'</td></tr>';}).join('')+'</tbody></table>':'<div class="empty">暂无日线记录</div>';}catch(error){byId('bars').innerHTML='<div class="empty">'+esc(error.message)+'</div>';}}
    byId('query').addEventListener('input',(event)=>{clearTimeout(timer);timer=setTimeout(()=>{state.query=event.target.value.trim();state.offset=0;load();},350);});
    document.querySelectorAll('.filter').forEach((button)=>button.addEventListener('click',()=>{document.querySelectorAll('.filter').forEach((item)=>item.classList.remove('active'));button.classList.add('active');state.type=button.dataset.type;state.offset=0;load();}));
    byId('previous').addEventListener('click',()=>{state.offset=Math.max(0,state.offset-state.limit);load();scrollTo({top:0,behavior:'smooth'});});byId('next').addEventListener('click',()=>{state.offset+=state.limit;load();scrollTo({top:0,behavior:'smooth'});});byId('close-detail').addEventListener('click',()=>byId('detail').classList.remove('visible'));
    byId('save-health').addEventListener('click',async()=>{try{renderHealth(await request('/v1/data-sources/schedule',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true,interval_seconds:Number(byId('health-interval').value)})}));}catch(error){byId('health-summary').textContent=error.message;}});byId('check-health').addEventListener('click',async()=>{byId('check-health').disabled=true;try{renderHealth(await request('/v1/data-sources/check',{method:'POST'}));}catch(error){byId('health-summary').textContent=error.message;}finally{byId('check-health').disabled=false;}});load();loadHealth();
  </script>
</body>
</html>`
