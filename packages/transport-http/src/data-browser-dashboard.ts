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
    .shell { position:relative; width:min(1180px,calc(100% - 40px)); margin:auto; padding:28px 0 70px; }
    .warehouse { padding:10px 20px; color:var(--green); background:#0a1713; border-bottom:1px solid var(--line); font:500 11px "DM Mono",monospace; text-align:right; }
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
    .detail-head { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; padding:20px 22px; border-bottom:1px solid var(--line); }
    .detail-actions { display:flex; gap:6px; }
    .detail-actions button { background:#15251f; }
    .detail-title { font-size:18px; font-weight:700; } .detail-note { margin-top:4px; }
    .detail-controls { display:grid; grid-template-columns:160px 210px 180px 1fr; gap:10px; align-items:start; padding:16px 22px; border-bottom:1px solid var(--line); }
    .control { min-width:0; display:grid; grid-template-rows:18px 42px; gap:6px; }
    .control label { display:block; height:18px; margin:0; color:var(--muted); font-size:10px; line-height:18px; letter-spacing:.06em; }
    .control > input,.control > select { height:42px; min-height:42px; }
    .detail-controls > .mono { align-self:end; min-height:42px; display:flex; align-items:center; }
    .coverage-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--line); border-bottom:1px solid var(--line); }
    .coverage-card { min-height:92px; padding:16px 18px; background:#0d1b17; }
    .coverage-label { color:var(--muted); font-size:10px; margin-bottom:9px; }
    .coverage-value { font:500 13px "DM Mono",monospace; overflow-wrap:anywhere; }
    .positive { color:var(--green); } .negative { color:var(--red); }
    .view-switch { height:42px; display:flex; gap:4px; padding:4px; border-radius:11px; background:#10201b; }
    .view-switch button { flex:1; padding:6px 8px; }
    .view-switch button.active { color:var(--green); background:#1b3028; }
    [hidden] { display:none!important; }
    .chart-wrap { position:relative; min-height:420px; border-bottom:1px solid var(--line); background:linear-gradient(180deg,rgba(15,32,27,.62),rgba(8,20,17,.84)); touch-action:pan-y; }
    .chart-wrap canvas { display:block; width:100%; height:420px; cursor:grab; }
    .chart-wrap canvas:active { cursor:grabbing; }
    .chart-empty { position:absolute; inset:0; display:grid; place-items:center; color:var(--muted); font-size:12px; pointer-events:none; }
    .chart-tooltip { position:absolute; z-index:2; max-width:calc(100% - 24px); padding:8px 10px; border:1px solid var(--line); border-radius:8px; color:var(--ink); background:rgba(7,17,15,.92); box-shadow:0 8px 24px rgba(0,0,0,.25); font:500 10px/1.6 "DM Mono",monospace; white-space:nowrap; pointer-events:none; transform:translate(12px,12px); }
    .bar-pager { border-top:1px solid var(--line); }
    @keyframes rise { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
    @media(max-width:800px) { .toolbar{align-items:stretch;flex-direction:column}.filters button{flex:1}.filters{width:100%}.warehouse{text-align:left}.hide-mobile{display:none}.detail-controls{grid-template-columns:1fr 1fr}.coverage-grid{grid-template-columns:1fr 1fr}.chart-wrap,.chart-wrap canvas{height:360px;min-height:360px} }
    @media(max-width:520px) { .shell{width:calc(100% - 24px);padding-top:20px}th,td{padding:12px}.identity{min-width:145px}.pager{align-items:flex-start;flex-direction:column}.pager-actions{width:100%}.pager-actions button{flex:1}.detail-controls{grid-template-columns:1fr}.coverage-grid{grid-template-columns:1fr}.chart-wrap,.chart-wrap canvas{height:320px;min-height:320px} }
  </style>
</head>
<body>
  ${adminNavigation('home')}
  <main class="shell">
    <section class="panel">
      <div class="warehouse" id="warehouse">正在连接本地仓库</div>
      <div class="toolbar"><div class="search"><input id="query" type="search" placeholder="输入代码或名称，例如 000001、IF2609、XAU、BTC-USDT" autocomplete="off"></div><div class="filters"><button class="filter active" data-type="" data-market="">全部</button><button class="filter" data-type="equity" data-market="">股票</button><button class="filter" data-type="index" data-market="">指数</button><button class="filter" data-type="future" data-market="CN">国内期货</button><button class="filter" data-type="future" data-market="GLOBAL">国际期货</button><button class="filter" data-type="crypto" data-market="">加密货币</button></div><div class="filters"><button class="period-filter active" data-interval="">全部周期</button><button class="period-filter" data-interval="1d">日线</button><button class="period-filter" data-interval="1m">1分钟</button></div></div>
      <div class="table-wrap" id="list"><div class="empty">正在读取库内标的…</div></div><div class="pager"><span id="summary">—</span><div class="pager-actions"><button id="previous" disabled>上一页</button><button id="next" disabled>下一页</button></div></div>
    </section>
    <section class="panel detail" id="detail">
      <div class="detail-head"><div><div class="detail-title" id="detail-title">—</div><div class="detail-note mono" id="detail-id">—</div></div><div class="detail-actions"><button id="chart-zoom-in" aria-label="放大行情">＋ 放大</button><button id="chart-zoom-out" aria-label="缩小行情">－ 缩小</button><button class="close" id="close-detail">关闭</button></div></div>
      <div class="detail-controls"><div class="control"><label for="detail-interval">行情周期</label><select id="detail-interval"><option value="1m">1 分钟</option><option value="1d">日线</option></select></div><div class="control"><label for="detail-date">交易日期</label><input id="detail-date" type="date"></div><div class="control"><label>展示方式</label><div class="view-switch" role="group" aria-label="行情展示方式"><button class="active" data-view="chart" aria-pressed="true">行情柱图</button><button data-view="table" aria-pressed="false">表格</button></div></div><div class="mono">LOCAL ONLY · 每页最多 500 条，不调用远程数据源</div></div>
      <div class="coverage-grid" id="coverage"><div class="coverage-card"><div class="coverage-label">请求范围</div><div class="coverage-value">—</div></div></div><div class="chart-wrap" id="bar-chart"><canvas id="bar-chart-canvas" aria-label="行情柱图与成交量图" role="img"></canvas><div class="chart-empty" id="bar-chart-empty">请选择一个标的</div><div class="chart-tooltip" id="bar-chart-tooltip" hidden></div></div><div class="table-wrap" id="bars" hidden><div class="empty">请选择一个标的</div></div><div class="pager bar-pager"><span id="bar-summary">拖动浏览 · 滚轮缩放</span><div class="pager-actions"><button id="bar-previous">回到最新</button><button id="bar-next">加载更早</button></div></div>
    </section>
  </main>
  <script>
    const byId=(id)=>document.getElementById(id);const esc=(v)=>String(v).replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    const state={query:'',type:'',market:'',interval:'',offset:0,limit:30,total:0,selectedId:'',detailInterval:'1m',detailDate:'',barOffset:0,barLimit:500,barTotal:0,barRows:[],barViewportStart:0,barViewportSize:120,barView:'chart',hoveredBar:-1,chartDrag:null,loadingOlder:false};let timer,barsController,coverageController,chartFrame;
    async function request(url,options){const response=await fetch(url,options);const body=await response.json();if(!response.ok)throw new Error(body.detail||'请求失败');return body;}
    function formatNumber(value){return Number(value).toLocaleString('zh-CN');}
    function formatBytes(value){if(value===null||value===undefined)return '内存数据库';const units=['B','KB','MB','GB','TB'];let size=Number(value),unit=0;while(size>=1024&&unit<units.length-1){size/=1024;unit+=1;}return size.toFixed(unit<2?0:1)+' '+units[unit];}
    function range(first,last){return first&&last?esc(first)+' → '+esc(last):'—';}
    const typeName=(item)=>item.instrument_type==='equity'?'股票':item.instrument_type==='index'?'指数':item.instrument_type==='future'?(item.market==='GLOBAL'?'国际期货':'国内期货'):item.instrument_type==='crypto'?'加密货币':item.instrument_type;
    function instrumentTable(items){if(!items.length)return '<div class="empty">没有找到已落库的标的</div>';return '<table><thead><tr><th>标的</th><th>类型</th><th>交易场所</th><th>日线记录</th><th>1m 记录</th><th>日线实际范围</th></tr></thead><tbody>'+items.map((item)=>'<tr data-id="'+esc(item.instrument_id)+'" data-label="'+esc(item.name+' · '+item.symbol+' · '+(item.venue||item.publisher||''))+'" data-minute="'+item.minute_records+'" data-minute-end="'+esc(item.minute_last_trading_date||'')+'" data-daily-end="'+esc(item.daily_last_trading_date||'')+'"><td class="identity"><strong>'+esc(item.name)+'</strong><span class="mono">'+esc(item.symbol)+'</span></td><td><span class="type">'+esc(typeName(item))+'</span></td><td class="mono">'+esc(item.venue||item.publisher||'—')+'</td><td class="number">'+formatNumber(item.daily_records)+'</td><td class="number">'+formatNumber(item.minute_records)+'</td><td class="mono hide-mobile">'+range(item.daily_first_trading_date,item.daily_last_trading_date)+'</td></tr>').join('')+'</tbody></table>';}
    async function load(){const params=new URLSearchParams({limit:String(state.limit),offset:String(state.offset)});if(state.query)params.set('q',state.query);if(state.type)params.set('type',state.type);if(state.market)params.set('market',state.market);if(state.interval)params.set('interval',state.interval);try{const body=await request('/v1/local-data/instruments?'+params);state.total=body.page.total;byId('list').innerHTML=instrumentTable(body.data);const from=state.total?state.offset+1:0;const to=Math.min(state.offset+state.limit,state.total);byId('summary').textContent='显示 '+from+'–'+to+' / 共 '+formatNumber(state.total)+' 个标的';byId('previous').disabled=state.offset===0;byId('next').disabled=state.offset+state.limit>=state.total;const storage=body.meta.storage;byId('warehouse').textContent=formatNumber(storage.daily_bars)+' 条日线 · '+formatNumber(storage.minute_bars)+' 条 1m · '+formatBytes(storage.database_bytes);bindRows();}catch(error){byId('list').innerHTML='<div class="empty">'+esc(error.message)+'</div>';}}
    function bindRows(){document.querySelectorAll('#list tbody tr[data-id]').forEach((row)=>row.addEventListener('click',()=>openDetail(row.dataset.id,row.dataset.label,Number(row.dataset.minute)>0,row.dataset.minuteEnd,row.dataset.dailyEnd)));}
    function renderCoverage(coverage){byId('coverage').innerHTML='<div class="coverage-card"><div class="coverage-label">请求范围</div><div class="coverage-value">'+range(coverage.requested_start,coverage.requested_end)+'</div></div><div class="coverage-card"><div class="coverage-label">实际范围</div><div class="coverage-value">'+range(coverage.actual_start,coverage.actual_end)+'</div></div><div class="coverage-card"><div class="coverage-label">记录与来源</div><div class="coverage-value">'+formatNumber(coverage.records)+' 条<br><span class="mono">'+esc(coverage.sources.join('、')||'—')+'</span></div></div><div class="coverage-card"><div class="coverage-label">最后同步</div><div class="coverage-value">'+(coverage.last_fetched_at?new Date(coverage.last_fetched_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—')+'</div></div>';}
    function barTable(rows){if(!rows.length)return '<div class="empty">所选范围内没有本地记录</div>';const minute=state.detailInterval==='1m';return '<table><thead><tr><th>'+(minute?'时间':'交易日')+'</th><th>开盘</th><th>最高</th><th>最低</th><th>收盘</th><th>成交量</th><th>成交额</th></tr></thead><tbody>'+rows.map((bar)=>{const move=Number(bar.close)-Number(bar.open);const time=minute?bar.period_end.slice(11,19):bar.trading_date;return '<tr><td class="mono">'+esc(time)+'</td><td>'+esc(bar.open)+'</td><td>'+esc(bar.high)+'</td><td>'+esc(bar.low)+'</td><td class="number '+(move>=0?'positive':'negative')+'">'+esc(bar.close)+'</td><td class="number">'+(bar.volume===null?'—':formatNumber(bar.volume))+'</td><td class="number">'+(bar.turnover===null?'—':formatNumber(Math.round(Number(bar.turnover))))+'</td></tr>';}).join('')+'</tbody></table>';}
    function chartTime(bar){return state.detailInterval==='1m'?bar.period_end.slice(5,16).replace('T',' '):bar.trading_date;}
    function shortNumber(value){if(value===null||value===undefined)return '—';const number=Number(value);if(!Number.isFinite(number))return '—';if(Math.abs(number)>=100000000)return (number/100000000).toFixed(1)+'亿';if(Math.abs(number)>=10000)return (number/10000).toFixed(1)+'万';return number.toLocaleString('zh-CN');}
    function scheduleChart(){if(chartFrame)return;chartFrame=requestAnimationFrame(()=>{chartFrame=0;drawChart();});}
    function clampViewport(start,size=state.barViewportSize){const boundedSize=Math.max(20,Math.min(240,state.barRows.length||20,Math.round(size)));state.barViewportSize=boundedSize;state.barViewportStart=Math.max(0,Math.min(Math.max(0,state.barRows.length-boundedSize),Math.round(start)));scheduleChart();}
    function zoomChart(factor,anchor=.5){if(!state.barRows.length)return;const nextSize=Math.max(20,Math.min(240,Math.round(state.barViewportSize*factor))),anchorIndex=state.barViewportStart+state.barViewportSize*anchor;clampViewport(anchorIndex-nextSize*anchor,nextSize);}
    function panChart(delta){clampViewport(state.barViewportStart+delta);if(state.barViewportStart<8)loadOlderBars();}
    function drawChart(){
      const canvas=byId('bar-chart-canvas'),wrap=byId('bar-chart'),empty=byId('bar-chart-empty'),rows=state.barRows.slice(state.barViewportStart,state.barViewportStart+state.barViewportSize);
      const width=wrap.clientWidth,height=canvas.clientHeight;if(!width||!height)return;
      const ratio=Math.min(window.devicePixelRatio||1,2),pixelWidth=Math.round(width*ratio),pixelHeight=Math.round(height*ratio);
      if(canvas.width!==pixelWidth||canvas.height!==pixelHeight){canvas.width=pixelWidth;canvas.height=pixelHeight;}
      const context=canvas.getContext('2d');context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,width,height);
      if(!rows.length){empty.hidden=false;return;}empty.hidden=true;
      const left=58,right=16,top=18,bottom=28,volumeHeight=Math.min(78,height*.23),gap=18;
      const plotWidth=Math.max(1,width-left-right),priceBottom=height-bottom-volumeHeight-gap,priceHeight=Math.max(1,priceBottom-top);
      let low=Infinity,high=-Infinity,maxVolume=0;rows.forEach((bar)=>{low=Math.min(low,Number(bar.low));high=Math.max(high,Number(bar.high));maxVolume=Math.max(maxVolume,Number(bar.volume)||0);});
      const padding=(high-low)*.06||Math.max(Math.abs(high)*.01,.01);low-=padding;high+=padding;
      const priceY=(value)=>top+(high-Number(value))/(high-low)*priceHeight;
      context.font='10px "DM Mono", monospace';context.textBaseline='middle';context.lineWidth=1;
      for(let line=0;line<=4;line+=1){const y=top+priceHeight*line/4;context.strokeStyle='rgba(151,199,183,.10)';context.beginPath();context.moveTo(left,y+.5);context.lineTo(width-right,y+.5);context.stroke();context.fillStyle='#71877f';context.textAlign='right';context.fillText((high-(high-low)*line/4).toFixed(high<10?3:2),left-8,y);}
      const step=plotWidth/rows.length,candleWidth=Math.max(1,Math.min(9,step*.64));
      rows.forEach((bar,index)=>{const x=left+(index+.5)*step,open=Number(bar.open),close=Number(bar.close),barHigh=Number(bar.high),barLow=Number(bar.low),rising=close>=open,color=rising?'#59d6ad':'#ee806c';context.strokeStyle=color;context.fillStyle=color;context.beginPath();context.moveTo(x,priceY(barHigh));context.lineTo(x,priceY(barLow));context.stroke();const bodyTop=Math.min(priceY(open),priceY(close)),bodyHeight=Math.max(1,Math.abs(priceY(open)-priceY(close)));context.fillRect(x-candleWidth/2,bodyTop,candleWidth,bodyHeight);if(maxVolume>0&&bar.volume!==null){const volumeHeightValue=(Number(bar.volume)/maxVolume)*volumeHeight;context.globalAlpha=.34;context.fillRect(x-candleWidth/2,height-bottom-volumeHeightValue,candleWidth,volumeHeightValue);context.globalAlpha=1;}});
      const tickCount=Math.min(5,rows.length,Math.max(2,Math.floor(plotWidth/90)));context.fillStyle='#71877f';context.textAlign='center';context.textBaseline='bottom';for(let tick=0;tick<tickCount;tick+=1){const index=tickCount===1?0:Math.round(tick*(rows.length-1)/(tickCount-1)),x=left+(index+.5)*step;context.fillText(chartTime(rows[index]),Math.max(left+26,Math.min(width-right-26,x)),height-5);}
      if(state.hoveredBar>=0&&state.hoveredBar<rows.length){const index=state.hoveredBar,bar=rows[index],x=left+(index+.5)*step,y=priceY(bar.close);context.strokeStyle='rgba(231,241,237,.32)';context.setLineDash([4,4]);context.beginPath();context.moveTo(x,top);context.lineTo(x,height-bottom);context.moveTo(left,y);context.lineTo(width-right,y);context.stroke();context.setLineDash([]);}
    }
    function setBarRows(rows,message){state.barRows=rows.slice().reverse();state.barViewportSize=Math.min(120,state.barRows.length);state.barViewportStart=Math.max(0,state.barRows.length-state.barViewportSize);state.hoveredBar=-1;byId('bar-chart-empty').textContent=message||'所选范围内没有本地记录';byId('bar-chart-tooltip').hidden=true;scheduleChart();}
    function setBarView(view){state.barView=view;document.querySelectorAll('[data-view]').forEach((button)=>{const active=button.dataset.view===view;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});byId('bar-chart').hidden=view!=='chart';byId('bars').hidden=view!=='table';if(view==='chart')scheduleChart();}
    async function loadBars(){if(!state.selectedId)return;if(barsController)barsController.abort();barsController=new AbortController();const signal=barsController.signal;const params=new URLSearchParams({interval:state.detailInterval,limit:String(state.barLimit),offset:'0'});if(state.detailDate){params.set('start',state.detailDate);params.set('end',state.detailDate);}byId('bars').innerHTML='<div class="empty">正在读取本地行情…</div>';setBarRows([],'正在读取本地行情…');try{const body=await request('/v1/local-data/instruments/'+encodeURIComponent(state.selectedId)+'/bars?'+params,{signal});state.barTotal=body.page.total;state.barOffset=0;byId('bars').innerHTML=barTable(body.data);setBarRows(body.data);byId('bar-summary').textContent='已加载 '+formatNumber(body.data.length)+' / '+formatNumber(state.barTotal)+' 条 · 拖动浏览，滚轮缩放';byId('bar-previous').disabled=!body.data.length;byId('bar-next').disabled=Boolean(state.detailDate)||body.data.length>=state.barTotal;}catch(error){if(error.name==='AbortError')return;byId('bars').innerHTML='<div class="empty">'+esc(error.message)+'</div>';setBarRows([],error.message);}}
    async function loadOlderBars(){if(state.loadingOlder||state.detailDate||state.barRows.length>=state.barTotal)return;state.loadingOlder=true;byId('bar-next').disabled=true;const offset=state.barRows.length,params=new URLSearchParams({interval:state.detailInterval,limit:String(state.barLimit),offset:String(offset)});try{const body=await request('/v1/local-data/instruments/'+encodeURIComponent(state.selectedId)+'/bars?'+params),older=body.data.slice().reverse(),seen=new Set(state.barRows.map((bar)=>bar.period_end)),fresh=older.filter((bar)=>!seen.has(bar.period_end));if(!fresh.length)return;state.barRows=[...fresh,...state.barRows];state.barViewportStart+=fresh.length;byId('bar-summary').textContent='已加载 '+formatNumber(state.barRows.length)+' / '+formatNumber(state.barTotal)+' 条本地记录';scheduleChart();}catch(error){byId('bar-summary').textContent=error.message;}finally{state.loadingOlder=false;byId('bar-next').disabled=state.barRows.length>=state.barTotal;}}
    async function loadCoverage(setDefaultDate){if(!state.selectedId)return;if(coverageController)coverageController.abort();coverageController=new AbortController();const signal=coverageController.signal;try{const body=await request('/v1/local-data/instruments/'+encodeURIComponent(state.selectedId)+'/coverage?interval='+state.detailInterval,{signal});renderCoverage(body.data);if(setDefaultDate){state.detailDate=state.detailInterval==='1m'?(body.data.actual_end||''):'';byId('detail-date').value=state.detailDate;}state.barOffset=0;await loadBars();}catch(error){if(error.name==='AbortError')return;byId('coverage').innerHTML='<div class="empty">'+esc(error.message)+'</div>';}}
    async function openDetail(id,label,hasMinute,minuteEnd){state.selectedId=id;state.detailInterval=hasMinute?'1m':'1d';state.detailDate=state.detailInterval==='1m'?minuteEnd:'';state.barOffset=0;byId('detail').classList.add('visible');byId('detail-title').textContent=label;byId('detail-id').textContent=id;byId('detail-interval').value=state.detailInterval;byId('detail-date').value=state.detailDate||'';setBarView(state.barView);byId('detail').scrollIntoView({behavior:'smooth',block:'start'});await loadCoverage(false);}
    document.querySelectorAll('[data-view]').forEach((button)=>button.addEventListener('click',()=>setBarView(button.dataset.view)));
    function chartLocalIndex(event){const canvas=event.currentTarget,rect=canvas.getBoundingClientRect(),plotWidth=Math.max(1,rect.width-58-16),relative=Math.max(0,Math.min(plotWidth-1,event.clientX-rect.left-58));return Math.max(0,Math.min(state.barViewportSize-1,Math.floor(relative/plotWidth*state.barViewportSize)));}
    byId('bar-chart-canvas').addEventListener('pointerdown',(event)=>{if(!state.barRows.length)return;event.currentTarget.setPointerCapture(event.pointerId);state.chartDrag={x:event.clientX,start:state.barViewportStart};});
    byId('bar-chart-canvas').addEventListener('pointermove',(event)=>{if(!state.barRows.length)return;const canvas=event.currentTarget,rect=canvas.getBoundingClientRect(),index=chartLocalIndex(event),bar=state.barRows[state.barViewportStart+index],tooltip=byId('bar-chart-tooltip');if(state.chartDrag){const plotWidth=Math.max(1,rect.width-58-16),delta=(state.chartDrag.x-event.clientX)/plotWidth*state.barViewportSize;clampViewport(state.chartDrag.start+delta);if(state.barViewportStart<8)loadOlderBars();return;}state.hoveredBar=index;tooltip.textContent=chartTime(bar)+'  开 '+bar.open+'  高 '+bar.high+'  低 '+bar.low+'  收 '+bar.close+'  量 '+shortNumber(bar.volume);tooltip.hidden=false;const tooltipWidth=tooltip.offsetWidth,tooltipHeight=tooltip.offsetHeight;tooltip.style.left=Math.max(4,Math.min(rect.width-tooltipWidth-16,event.clientX-rect.left))+'px';tooltip.style.top=Math.max(4,Math.min(rect.height-tooltipHeight-16,event.clientY-rect.top))+'px';scheduleChart();});
    byId('bar-chart-canvas').addEventListener('pointerup',()=>{state.chartDrag=null;});
    byId('bar-chart-canvas').addEventListener('pointercancel',()=>{state.chartDrag=null;});
    byId('bar-chart-canvas').addEventListener('pointerleave',()=>{if(!state.chartDrag){state.hoveredBar=-1;byId('bar-chart-tooltip').hidden=true;scheduleChart();}});
    byId('bar-chart-canvas').addEventListener('wheel',(event)=>{if(!state.barRows.length)return;event.preventDefault();const rect=event.currentTarget.getBoundingClientRect(),anchor=Math.max(0,Math.min(1,(event.clientX-rect.left-58)/(rect.width-58-16)));if(Math.abs(event.deltaX)>Math.abs(event.deltaY))panChart(event.deltaX/12);else zoomChart(Math.exp(event.deltaY*.0015),anchor);},{passive:false});
    byId('chart-zoom-in').addEventListener('click',()=>zoomChart(.75));byId('chart-zoom-out').addEventListener('click',()=>zoomChart(1.3));
    if('ResizeObserver' in window)new ResizeObserver(scheduleChart).observe(byId('bar-chart'));else window.addEventListener('resize',scheduleChart);
    byId('query').addEventListener('input',(event)=>{clearTimeout(timer);timer=setTimeout(()=>{state.query=event.target.value.trim();state.offset=0;load();},350);});document.querySelectorAll('.filter').forEach((button)=>button.addEventListener('click',()=>{document.querySelectorAll('.filter').forEach((item)=>item.classList.remove('active'));button.classList.add('active');state.type=button.dataset.type;state.market=button.dataset.market;state.offset=0;load();}));document.querySelectorAll('.period-filter').forEach((button)=>button.addEventListener('click',()=>{document.querySelectorAll('.period-filter').forEach((item)=>item.classList.remove('active'));button.classList.add('active');state.interval=button.dataset.interval;state.offset=0;load();}));
    byId('detail-interval').addEventListener('change',(event)=>{state.detailInterval=event.target.value;state.detailDate='';byId('detail-date').value='';loadCoverage(true);});byId('detail-date').addEventListener('change',(event)=>{state.detailDate=event.target.value;state.barOffset=0;loadBars();});byId('previous').addEventListener('click',()=>{state.offset=Math.max(0,state.offset-state.limit);load();scrollTo({top:0,behavior:'smooth'});});byId('next').addEventListener('click',()=>{state.offset+=state.limit;load();scrollTo({top:0,behavior:'smooth'});});byId('bar-previous').addEventListener('click',()=>clampViewport(state.barRows.length-state.barViewportSize));byId('bar-next').addEventListener('click',loadOlderBars);byId('close-detail').addEventListener('click',()=>byId('detail').classList.remove('visible'));
    load();
  </script>
</body>
</html>`
