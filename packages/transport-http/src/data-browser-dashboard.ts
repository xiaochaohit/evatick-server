import { adminNavigation, adminNavigationStyles } from './admin-navigation.js'

export const dataBrowserDashboardHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>数据浏览 · EVA</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;600;700&display=swap');
    :root { --ink:#e7f1ed; --muted:#82968f; --paper:#07110f; --card:rgba(13,27,23,.9); --line:rgba(151,199,183,.13); --green:#59d6ad; --red:#ee806c; --amber:#e5b65e; --shadow:0 24px 60px rgba(0,0,0,.22); }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; color:var(--ink); font-family:"Noto Sans SC",sans-serif; background:radial-gradient(circle at 14% 5%,rgba(47,142,111,.16),transparent 30rem),radial-gradient(circle at 88% 74%,rgba(41,112,90,.10),transparent 30rem),var(--paper); }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background-image:linear-gradient(rgba(137,193,175,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(137,193,175,.025) 1px,transparent 1px); background-size:32px 32px; mask-image:linear-gradient(black,transparent 82%); }
    ${adminNavigationStyles}
    .shell { position:relative; width:min(1180px,calc(100% - 40px)); margin:auto; padding:48px 0 70px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; margin-bottom:28px; }
    .eyebrow { color:var(--green); font:500 12px "DM Mono",monospace; letter-spacing:.16em; margin-bottom:12px; }
    h1 { margin:0; font-size:clamp(36px,5vw,58px); line-height:1; letter-spacing:-.045em; }
    .subtitle { color:var(--muted); line-height:1.7; max-width:700px; margin:15px 0 0; }
    .warehouse { color:var(--green); font:500 12px "DM Mono",monospace; text-align:right; }
    .panel { border:1px solid var(--line); border-radius:22px; background:var(--card); box-shadow:var(--shadow); overflow:hidden; backdrop-filter:blur(18px); animation:rise .5s both; }
    .toolbar { display:flex; align-items:center; gap:12px; padding:18px 20px; border-bottom:1px solid var(--line); }
    .search { position:relative; flex:1; }
    .search::before { content:"⌕"; position:absolute; left:14px; top:9px; color:var(--green); font:18px "DM Mono",monospace; }
    input,select { width:100%; padding:10px 12px; color:var(--ink); background:#13231d; border:1px solid transparent; border-radius:11px; outline:none; font:500 13px "DM Mono",monospace; }
    .search input { padding-left:40px; }
    input:focus,select:focus { border-color:var(--green); background:#172a22; }
    .filters { display:flex; gap:4px; padding:4px; border-radius:12px; background:#10201b; }
    button { border:0; border-radius:9px; padding:9px 12px; color:var(--muted); background:transparent; cursor:pointer; font:600 12px "Noto Sans SC",sans-serif; }
    button:hover { color:var(--ink); } button:disabled { opacity:.35; cursor:not-allowed; }
    .filter.active,.period-filter.active { color:var(--green); background:#1b3028; }
    .table-wrap { overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th { padding:12px 18px; color:#60776e; text-align:left; font:500 10px "DM Mono",monospace; letter-spacing:.08em; border-bottom:1px solid var(--line); }
    td { padding:15px 18px; border-bottom:1px solid rgba(151,199,183,.08); font-size:12px; white-space:nowrap; }
    #list tbody tr { cursor:pointer; transition:background .18s; } #list tbody tr:hover { background:rgba(89,214,173,.045); }
    .identity { min-width:180px; white-space:normal; }
    .identity strong { display:block; font-size:14px; margin-bottom:3px; }
    .mono { color:var(--muted); font:500 11px "DM Mono",monospace; }
    .type { display:inline-block; padding:4px 7px; color:#07130f; background:var(--green); border-radius:6px; font-size:10px; font-weight:700; }
    .number { font:500 12px "DM Mono",monospace; }
    .empty { padding:46px 20px; text-align:center; color:var(--muted); }
    .pager { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 20px; color:var(--muted); font-size:12px; }
    .pager-actions { display:flex; gap:7px; } .pager-actions button,.close { background:#15251f; }
    .detail { display:none; margin-top:14px; }
    .detail.visible { display:block; }
    .detail-head { display:flex; align-items:flex-start; justify-content:space-between; padding:20px 22px; border-bottom:1px solid var(--line); }
    .detail-title { font-size:18px; font-weight:700; } .detail-note { margin-top:4px; }
    .detail-controls { display:grid; grid-template-columns:160px 210px 1fr; gap:10px; align-items:end; padding:16px 22px; border-bottom:1px solid var(--line); }
    .control label { display:block; color:var(--muted); font-size:10px; margin-bottom:6px; letter-spacing:.06em; }
    .coverage-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--line); border-bottom:1px solid var(--line); }
    .coverage-card { min-height:92px; padding:16px 18px; background:#0d1b17; }
    .coverage-label { color:var(--muted); font-size:10px; margin-bottom:9px; }
    .coverage-value { font:500 13px "DM Mono",monospace; overflow-wrap:anywhere; }
    .badge { display:inline-block; padding:5px 8px; border-radius:7px; font-size:10px; font-weight:700; }
    .badge.complete { color:var(--green); background:rgba(44,150,114,.16); }
    .badge.partial { color:var(--amber); background:rgba(203,145,46,.14); }
    .badge.none { color:var(--muted); background:#172720; }
    .positive { color:var(--green); } .negative { color:var(--red); }
    .bar-pager { border-top:1px solid var(--line); }
    .quality { padding:18px 22px; border-top:1px solid var(--line); }
    .quality-title { font-weight:700; font-size:13px; margin-bottom:4px; }
    .quality-note { color:var(--muted); font-size:11px; margin-bottom:12px; }
    .health { margin-top:14px; }
    .health-head { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:20px 22px; border-bottom:1px solid var(--line); }
    .health-title { font-size:17px; font-weight:700; } .health-subtitle { margin-top:4px; color:var(--muted); font-size:12px; }
    .health-actions { display:flex; align-items:center; gap:8px; }
    .health-actions select { width:auto; }
    .health-actions button { background:#15251f; } .health-actions .check-now { color:#07130f; background:var(--green); }
    .source-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:1px; background:var(--line); }
    .source-card { display:grid; grid-template-columns:1fr auto; gap:8px; padding:16px 20px; background:#0d1b17; }
    .source-name { font-weight:700; font-size:13px; } .source-meta { margin-top:4px; color:var(--muted); font:500 10px "DM Mono",monospace; }
    .source-status { align-self:center; padding:5px 8px; border-radius:7px; color:var(--muted); background:#172720; font-size:10px; font-weight:700; }
    .source-status.healthy { color:var(--green); background:rgba(44,150,114,.16); } .source-status.unhealthy { color:var(--red); background:rgba(190,73,55,.14); }
    @keyframes rise { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
    @media(max-width:800px) { .toolbar{align-items:stretch;flex-direction:column}.filters button{flex:1}.filters{width:100%}header{align-items:flex-start;flex-direction:column}.warehouse{text-align:left}.hide-mobile{display:none}.health-head{align-items:flex-start;flex-direction:column}.health-actions{width:100%;flex-wrap:wrap}.health-actions select{flex:1}.source-grid{grid-template-columns:1fr}.detail-controls{grid-template-columns:1fr 1fr}.coverage-grid{grid-template-columns:1fr 1fr} }
    @media(max-width:520px) { .shell{width:calc(100% - 24px);padding-top:32px}th,td{padding:12px}.identity{min-width:145px}.pager{align-items:flex-start;flex-direction:column}.pager-actions{width:100%}.pager-actions button{flex:1}.detail-controls{grid-template-columns:1fr}.coverage-grid{grid-template-columns:1fr} }
  </style>
</head>
<body>
  ${adminNavigation('home')}
  <main class="shell">
    <header><div><div class="eyebrow">EVA LOCAL WAREHOUSE</div><h1>数据浏览</h1><p class="subtitle">严格只读本地 DuckDB，检查日线与 1 分钟行情的实际覆盖、记录数量和缺失情况；此页面不会触发远程回退。</p></div><div class="warehouse" id="warehouse">正在连接本地仓库</div></header>
    <section class="panel">
      <div class="toolbar"><div class="search"><input id="query" type="search" placeholder="输入代码或名称，例如 000001、平安银行、沪深 300" autocomplete="off"></div><div class="filters"><button class="filter active" data-type="">全部</button><button class="filter" data-type="equity">股票</button><button class="filter" data-type="index">指数</button></div><div class="filters"><button class="period-filter active" data-interval="">全部周期</button><button class="period-filter" data-interval="1d">日线</button><button class="period-filter" data-interval="1m">1分钟</button></div></div>
      <div class="table-wrap" id="list"><div class="empty">正在读取库内标的…</div></div><div class="pager"><span id="summary">—</span><div class="pager-actions"><button id="previous" disabled>上一页</button><button id="next" disabled>下一页</button></div></div>
    </section>
    <section class="panel detail" id="detail">
      <div class="detail-head"><div><div class="detail-title" id="detail-title">—</div><div class="detail-note mono" id="detail-id">—</div></div><button class="close" id="close-detail">关闭</button></div>
      <div class="detail-controls"><div class="control"><label for="detail-interval">行情周期</label><select id="detail-interval"><option value="1m">1 分钟</option><option value="1d">日线</option></select></div><div class="control"><label for="detail-date">交易日期</label><input id="detail-date" type="date"></div><div class="mono">LOCAL ONLY · 每页最多 500 条，不调用远程数据源</div></div>
      <div class="coverage-grid" id="coverage"><div class="coverage-card"><div class="coverage-label">覆盖状态</div><div class="coverage-value">—</div></div></div><div class="table-wrap" id="bars"><div class="empty">请选择一个标的</div></div><div class="pager bar-pager"><span id="bar-summary">—</span><div class="pager-actions"><button id="bar-previous" disabled>上一页</button><button id="bar-next" disabled>下一页</button></div></div><div class="quality" id="quality"><div class="quality-title">每日分钟完整性</div><div class="quality-note">选择 1 分钟周期后显示。</div></div>
    </section>
    <section class="panel health" id="data-sources"><div class="health-head"><div><div class="health-title">数据源健康</div><div class="health-subtitle" id="health-summary">作为辅助监控，按股票与指数检查远程上游可用性</div></div><div class="health-actions"><select id="health-interval"><option value="3600">每 1 小时</option><option value="10800">每 3 小时</option><option value="21600">每 6 小时</option><option value="43200">每 12 小时</option><option value="86400">每 24 小时</option></select><button id="save-health">保存周期</button><button class="check-now" id="check-health">立即检查</button></div></div><div class="source-grid" id="health-list"><div class="empty">正在读取数据源状态…</div></div></section>
  </main>
  <script>
    const byId=(id)=>document.getElementById(id);const esc=(v)=>String(v).replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    const state={query:'',type:'',interval:'',offset:0,limit:30,total:0,selectedId:'',detailInterval:'1m',detailDate:'',barOffset:0,barLimit:500,barTotal:0};let timer;
    async function request(url,options){const response=await fetch(url,options);const body=await response.json();if(!response.ok)throw new Error(body.detail||'请求失败');return body;}
    function formatNumber(value){return Number(value).toLocaleString('zh-CN');}
    function formatBytes(value){if(value===null||value===undefined)return '内存数据库';const units=['B','KB','MB','GB','TB'];let size=Number(value),unit=0;while(size>=1024&&unit<units.length-1){size/=1024;unit+=1;}return size.toFixed(unit<2?0:1)+' '+units[unit];}
    const coverageLabels={complete:'完整',partial:'部分覆盖',none:'无数据'};
    function range(first,last){return first&&last?esc(first)+' → '+esc(last):'—';}
    function instrumentTable(items){if(!items.length)return '<div class="empty">没有找到已落库的标的</div>';return '<table><thead><tr><th>标的</th><th>类型</th><th>市场</th><th>日线记录</th><th>1m 记录</th><th>1m 实际覆盖</th><th>覆盖状态</th></tr></thead><tbody>'+items.map((item)=>'<tr data-id="'+esc(item.instrument_id)+'" data-label="'+esc(item.name+' · '+item.symbol)+'" data-minute="'+item.minute_records+'" data-minute-end="'+esc(item.minute_last_trading_date||'')+'" data-daily-end="'+esc(item.daily_last_trading_date||'')+'"><td class="identity"><strong>'+esc(item.name)+'</strong><span class="mono">'+esc(item.symbol)+'</span></td><td><span class="type">'+(item.instrument_type==='equity'?'股票':'指数')+'</span></td><td class="mono">'+esc(item.venue||item.publisher||'—')+'</td><td class="number">'+formatNumber(item.daily_records)+'</td><td class="number">'+formatNumber(item.minute_records)+'</td><td class="mono hide-mobile">'+range(item.minute_first_trading_date,item.minute_last_trading_date)+'</td><td><span class="badge '+item.minute_coverage_status+'">'+coverageLabels[item.minute_coverage_status]+'</span></td></tr>').join('')+'</tbody></table>';}
    async function load(){const params=new URLSearchParams({limit:String(state.limit),offset:String(state.offset)});if(state.query)params.set('q',state.query);if(state.type)params.set('type',state.type);if(state.interval)params.set('interval',state.interval);try{const body=await request('/v1/local-data/instruments?'+params);state.total=body.page.total;byId('list').innerHTML=instrumentTable(body.data);const from=state.total?state.offset+1:0;const to=Math.min(state.offset+state.limit,state.total);byId('summary').textContent='显示 '+from+'–'+to+' / 共 '+formatNumber(state.total)+' 个标的';byId('previous').disabled=state.offset===0;byId('next').disabled=state.offset+state.limit>=state.total;const storage=body.meta.storage;byId('warehouse').textContent=formatNumber(storage.daily_bars)+' 条日线 · '+formatNumber(storage.minute_bars)+' 条 1m · '+formatBytes(storage.database_bytes);bindRows();}catch(error){byId('list').innerHTML='<div class="empty">'+esc(error.message)+'</div>';}}
    function bindRows(){document.querySelectorAll('#list tbody tr[data-id]').forEach((row)=>row.addEventListener('click',()=>openDetail(row.dataset.id,row.dataset.label,Number(row.dataset.minute)>0,row.dataset.minuteEnd,row.dataset.dailyEnd)));}
    function renderCoverage(coverage){const status=coverage.status;byId('coverage').innerHTML='<div class="coverage-card"><div class="coverage-label">覆盖状态</div><div class="coverage-value"><span class="badge '+status+'">'+coverageLabels[status]+'</span></div></div><div class="coverage-card"><div class="coverage-label">请求范围</div><div class="coverage-value">'+range(coverage.requested_start,coverage.requested_end)+'</div></div><div class="coverage-card"><div class="coverage-label">实际范围</div><div class="coverage-value">'+range(coverage.actual_start,coverage.actual_end)+'</div></div><div class="coverage-card"><div class="coverage-label">记录与来源</div><div class="coverage-value">'+formatNumber(coverage.records)+' 条<br><span class="mono">'+esc(coverage.sources.join('、')||'—')+'</span></div></div>';if(coverage.interval!=='1m'){byId('quality').innerHTML='<div class="quality-title">每日分钟完整性</div><div class="quality-note">切换到 1 分钟周期后显示。</div>';return;}const rows=coverage.daily.slice(0,20);byId('quality').innerHTML='<div class="quality-title">每日分钟完整性</div><div class="quality-note">每日 240 根仅作为检查参考；停牌、集合竞价及上游口径可能造成差异。</div>'+(rows.length?'<div class="table-wrap"><table><thead><tr><th>交易日</th><th>记录数</th><th>参考缺失</th><th>状态</th></tr></thead><tbody>'+rows.map((day)=>'<tr><td class="mono">'+esc(day.trading_date)+'</td><td class="number">'+formatNumber(day.records)+'</td><td class="number">'+formatNumber(day.missing_records)+'</td><td><span class="badge '+day.status+'">'+(day.status==='complete'?'完整':'待检查')+'</span></td></tr>').join('')+'</tbody></table></div>':'<div class="empty">暂无分钟记录</div>');}
    function barTable(rows){if(!rows.length)return '<div class="empty">所选范围内没有本地记录</div>';const minute=state.detailInterval==='1m';return '<table><thead><tr><th>'+(minute?'时间':'交易日')+'</th><th>开盘</th><th>最高</th><th>最低</th><th>收盘</th><th>成交量</th><th>成交额</th></tr></thead><tbody>'+rows.map((bar)=>{const move=Number(bar.close)-Number(bar.open);const time=minute?bar.period_end.slice(11,19):bar.trading_date;return '<tr><td class="mono">'+esc(time)+'</td><td>'+esc(bar.open)+'</td><td>'+esc(bar.high)+'</td><td>'+esc(bar.low)+'</td><td class="number '+(move>=0?'positive':'negative')+'">'+esc(bar.close)+'</td><td class="number">'+(bar.volume===null?'—':formatNumber(bar.volume))+'</td><td class="number">'+(bar.turnover===null?'—':formatNumber(Math.round(Number(bar.turnover))))+'</td></tr>';}).join('')+'</tbody></table>';}
    async function loadBars(){if(!state.selectedId)return;const params=new URLSearchParams({interval:state.detailInterval,limit:String(state.barLimit),offset:String(state.barOffset)});if(state.detailDate){params.set('start',state.detailDate);params.set('end',state.detailDate);}byId('bars').innerHTML='<div class="empty">正在读取本地行情…</div>';try{const body=await request('/v1/local-data/instruments/'+encodeURIComponent(state.selectedId)+'/bars?'+params);state.barTotal=body.page.total;byId('bars').innerHTML=barTable(body.data);const from=state.barTotal?state.barOffset+1:0;const to=Math.min(state.barOffset+state.barLimit,state.barTotal);byId('bar-summary').textContent='本地记录 '+from+'–'+to+' / '+formatNumber(state.barTotal);byId('bar-previous').disabled=state.barOffset===0;byId('bar-next').disabled=state.barOffset+state.barLimit>=state.barTotal;}catch(error){byId('bars').innerHTML='<div class="empty">'+esc(error.message)+'</div>';}}
    async function loadCoverage(setDefaultDate){if(!state.selectedId)return;try{const body=await request('/v1/local-data/instruments/'+encodeURIComponent(state.selectedId)+'/coverage?interval='+state.detailInterval);renderCoverage(body.data);if(setDefaultDate){state.detailDate=body.data.actual_end||'';byId('detail-date').value=state.detailDate;}state.barOffset=0;await loadBars();}catch(error){byId('coverage').innerHTML='<div class="empty">'+esc(error.message)+'</div>';}}
    async function openDetail(id,label,hasMinute,minuteEnd,dailyEnd){state.selectedId=id;state.detailInterval=hasMinute?'1m':'1d';state.detailDate=state.detailInterval==='1m'?minuteEnd:dailyEnd;state.barOffset=0;byId('detail').classList.add('visible');byId('detail-title').textContent=label;byId('detail-id').textContent=id;byId('detail-interval').value=state.detailInterval;byId('detail-date').value=state.detailDate||'';byId('detail').scrollIntoView({behavior:'smooth',block:'start'});await loadCoverage(false);}
    const healthLabels={healthy:'健康',unhealthy:'异常',checking:'检测中',unknown:'未检测'};
    function renderHealth(body){const sources=body.data.filter((source)=>source.source_id!=='local');const healthy=sources.filter((source)=>source.status==='healthy').length;byId('health-summary').textContent='远程检测项 '+sources.length+' · 健康 '+healthy+' · '+(body.schedule.enabled?'每 '+Math.round(body.schedule.interval_seconds/3600)+' 小时自动检查':'自动检查已停用');if(body.schedule.enabled)byId('health-interval').value=String(body.schedule.interval_seconds);byId('health-list').innerHTML=sources.map((source)=>'<div class="source-card"><div><div class="source-name">'+esc(source.source_name)+' · '+(source.category==='equity'?'股票':'指数')+'</div><div class="source-meta">'+esc(source.source_id)+' · '+(source.latency_ms===null?'—':source.latency_ms+' ms')+'</div></div><span class="source-status '+source.status+'">'+healthLabels[source.status]+'</span></div>').join('')||'<div class="empty">暂无远程数据源</div>';}
    async function loadHealth(){try{renderHealth(await request('/v1/data-sources'));}catch(error){byId('health-summary').textContent=error.message;}}
    byId('query').addEventListener('input',(event)=>{clearTimeout(timer);timer=setTimeout(()=>{state.query=event.target.value.trim();state.offset=0;load();},350);});document.querySelectorAll('.filter').forEach((button)=>button.addEventListener('click',()=>{document.querySelectorAll('.filter').forEach((item)=>item.classList.remove('active'));button.classList.add('active');state.type=button.dataset.type;state.offset=0;load();}));document.querySelectorAll('.period-filter').forEach((button)=>button.addEventListener('click',()=>{document.querySelectorAll('.period-filter').forEach((item)=>item.classList.remove('active'));button.classList.add('active');state.interval=button.dataset.interval;state.offset=0;load();}));
    byId('detail-interval').addEventListener('change',(event)=>{state.detailInterval=event.target.value;state.detailDate='';byId('detail-date').value='';loadCoverage(true);});byId('detail-date').addEventListener('change',(event)=>{state.detailDate=event.target.value;state.barOffset=0;loadBars();});byId('previous').addEventListener('click',()=>{state.offset=Math.max(0,state.offset-state.limit);load();scrollTo({top:0,behavior:'smooth'});});byId('next').addEventListener('click',()=>{state.offset+=state.limit;load();scrollTo({top:0,behavior:'smooth'});});byId('bar-previous').addEventListener('click',()=>{state.barOffset=Math.max(0,state.barOffset-state.barLimit);loadBars();});byId('bar-next').addEventListener('click',()=>{state.barOffset+=state.barLimit;loadBars();});byId('close-detail').addEventListener('click',()=>byId('detail').classList.remove('visible'));
    byId('save-health').addEventListener('click',async()=>{try{renderHealth(await request('/v1/data-sources/schedule',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true,interval_seconds:Number(byId('health-interval').value)})}));}catch(error){byId('health-summary').textContent=error.message;}});byId('check-health').addEventListener('click',async()=>{byId('check-health').disabled=true;try{renderHealth(await request('/v1/data-sources/check',{method:'POST'}));}catch(error){byId('health-summary').textContent=error.message;}finally{byId('check-health').disabled=false;}});load();loadHealth();
  </script>
</body>
</html>`
