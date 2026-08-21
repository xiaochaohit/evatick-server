import { adminNavigation, adminNavigationStyles } from './admin-navigation.js'

export const dataSourceDashboardHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>数据源控制台 · EVA Tick Server</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;600;700&display=swap');
    :root {
      --ink: #e7f1ed;
      --muted: #82968f;
      --paper: #07110f;
      --card: rgba(13, 27, 23, .88);
      --line: rgba(151, 199, 183, .13);
      --green: #59d6ad;
      --green-soft: rgba(44, 150, 114, .18);
      --red: #ee806c;
      --red-soft: rgba(190, 73, 55, .17);
      --amber: #e5b65e;
      --amber-soft: rgba(183, 125, 33, .17);
      --shadow: 0 24px 60px rgba(0, 0, 0, .22);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      font-family: "Noto Sans SC", sans-serif;
      background:
        radial-gradient(circle at 14% 5%, rgba(47, 142, 111, .16), transparent 30rem),
        radial-gradient(circle at 88% 74%, rgba(41, 112, 90, .10), transparent 30rem),
        var(--paper);
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: .36;
      background-image: linear-gradient(rgba(137,193,175,.025) 1px, transparent 1px), linear-gradient(90deg, rgba(137,193,175,.025) 1px, transparent 1px);
      background-size: 32px 32px;
      mask-image: linear-gradient(to bottom, black, transparent 78%);
    }
    ${adminNavigationStyles}
    .shell { width: min(1180px, calc(100% - 40px)); margin: 0 auto; padding: 48px 0 64px; position: relative; }
    header { display: flex; align-items: flex-end; justify-content: space-between; gap: 32px; margin-bottom: 28px; }
    .eyebrow { color: var(--green); font: 500 12px/1 "DM Mono", monospace; letter-spacing: .16em; text-transform: uppercase; margin-bottom: 14px; }
    h1 { margin: 0; font-size: clamp(34px, 5vw, 58px); line-height: 1.05; letter-spacing: -.04em; }
    .subtitle { margin: 13px 0 0; color: var(--muted); max-width: 570px; line-height: 1.7; }
    .live { display: flex; align-items: center; gap: 9px; color: var(--muted); font: 500 12px "DM Mono", monospace; white-space: nowrap; }
    .live-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 6px rgba(20,122,85,.12); animation: pulse 2s infinite; }
    .overview { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
    .metric, .panel { background: var(--card); border: 1px solid var(--line); box-shadow: var(--shadow); backdrop-filter: blur(18px); }
    .metric { padding: 20px 22px; border-radius: 18px; animation: rise .55s both; }
    .metric:nth-child(2) { animation-delay: .06s; } .metric:nth-child(3) { animation-delay: .12s; } .metric:nth-child(4) { animation-delay: .18s; }
    .metric-label { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
    .metric-value { font: 500 29px/1.1 "DM Mono", monospace; letter-spacing: -.04em; }
    .main-grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 14px; }
    .panel { border-radius: 22px; overflow: hidden; animation: rise .6s .16s both; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 22px; border-bottom: 1px solid var(--line); }
    .panel-title { font-weight: 700; }
    .panel-note { color: var(--muted); font-size: 12px; margin-top: 4px; }
    button, select {
      border: 0; border-radius: 11px; font: 600 13px "Noto Sans SC", sans-serif; color: var(--ink);
    }
    button { cursor: pointer; padding: 10px 14px; transition: transform .18s, opacity .18s; }
    button:hover { transform: translateY(-1px); } button:disabled { opacity: .5; cursor: wait; transform: none; }
    .primary { background: var(--green); color: #07130f; }
    .secondary { background: #172720; color: var(--muted); }
    .head-actions { display: flex; align-items: center; gap: 10px; }
    .filters { display: flex; gap: 4px; padding: 4px; border-radius: 12px; background: #10201b; }
    .filter { padding: 6px 10px; background: transparent; color: var(--muted); }
    .filter.active { color: var(--green); background: #1b3028; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
    .source-list { padding: 8px; }
    .source { display: grid; grid-template-columns: 44px minmax(130px, 1fr) 110px 105px 105px; gap: 14px; align-items: center; padding: 16px 14px; border-radius: 15px; transition: background .2s; }
    .source + .source { border-top: 1px solid var(--line); }
    .source:hover { background: rgba(89, 214, 173, .045); }
    .source-mark { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; color: white; background: var(--green); font: 500 14px "DM Mono", monospace; }
    .source-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; }
    .source-id { margin-top: 3px; color: var(--muted); font: 400 10px "DM Mono", monospace; }
    .caps { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
    .cap { padding: 3px 7px; border-radius: 6px; background: #15251f; color: var(--muted); font: 500 10px "DM Mono", monospace; }
    .category { padding: 3px 7px; border-radius: 6px; color: #07130f; background: var(--green); font-size: 10px; font-weight: 700; }
    .status { justify-self: start; padding: 6px 9px; border-radius: 8px; font-size: 12px; font-weight: 700; }
    .healthy { color: var(--green); background: var(--green-soft); }
    .unhealthy { color: var(--red); background: var(--red-soft); }
    .checking, .unknown { color: var(--amber); background: var(--amber-soft); }
    .datum { font: 500 12px "DM Mono", monospace; color: var(--muted); }
    .empty { padding: 58px 20px; text-align: center; color: var(--muted); }
    .schedule { padding: 22px; animation-delay: .24s; }
    .schedule h2 { font-size: 16px; margin: 0 0 18px; }
    .schedule-state { padding: 16px; background: #10201b; border:1px solid var(--line); border-radius: 14px; margin-bottom: 20px; }
    .schedule-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .schedule-row + .schedule-row { margin-top: 12px; }
    .small-label { color: var(--muted); font-size: 12px; }
    .small-value { font: 500 12px "DM Mono", monospace; text-align: right; }
    label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 8px; }
    select { width: 100%; padding: 11px 12px; color:var(--ink); background: #13231d; outline: 1px solid transparent; }
    select:focus { outline-color: var(--green); }
    .schedule-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
    .schedule-actions button { width: 100%; }
    .error { margin-top: 14px; color: var(--red); font-size: 12px; line-height: 1.5; min-height: 18px; }
    footer { margin-top: 18px; color: var(--muted); font: 400 11px "DM Mono", monospace; text-align: right; }
    @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
    @keyframes pulse { 50% { box-shadow: 0 0 0 9px rgba(20,122,85,0); } }
    @media (max-width: 880px) {
      .overview { grid-template-columns: repeat(2, 1fr); }
      .main-grid { grid-template-columns: 1fr; }
      .source { grid-template-columns: 44px 1fr auto; }
      .source .datum { display: none; }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 24px, 1180px); padding-top: 32px; }
      header { align-items: flex-start; flex-direction: column; gap: 18px; }
      .overview { grid-template-columns: 1fr 1fr; gap: 8px; }
      .metric { padding: 16px; }
      .metric-value { font-size: 23px; }
      .panel-head { align-items: flex-start; }
      .panel-head { flex-direction: column; }
      .head-actions { width: 100%; justify-content: space-between; }
      .source { gap: 10px; padding: 14px 9px; }
      .source-mark { width: 36px; height: 36px; }
      .status { font-size: 11px; }
    }
  </style>
</head>
<body>
  ${adminNavigation('home')}
  <main class="shell">
    <header>
      <div>
        <div class="eyebrow">EVA Tick Server / Operations</div>
        <h1>数据源控制台</h1>
        <p class="subtitle">按股票、指数分类持续观察新浪、东方财富、腾讯等上游接口，在 fallback 掩盖故障前发现异常。</p>
      </div>
      <div class="live"><span class="live-dot"></span><span id="updated">正在连接服务</span></div>
    </header>

    <section class="overview">
      <article class="metric"><div class="metric-label">分类检测项</div><div class="metric-value" id="total">—</div></article>
      <article class="metric"><div class="metric-label">健康</div><div class="metric-value" id="healthy">—</div></article>
      <article class="metric"><div class="metric-label">异常</div><div class="metric-value" id="unhealthy">—</div></article>
      <article class="metric"><div class="metric-label">平均延迟</div><div class="metric-value" id="latency">—</div></article>
    </section>

    <section class="main-grid">
      <article class="panel">
        <div class="panel-head">
          <div><div class="panel-title">上游数据源健康</div><div class="panel-note">每个来源按股票、指数独立探测</div></div>
          <div class="head-actions">
            <div class="filters" id="filters">
              <button class="filter active" data-category="all">全部</button>
              <button class="filter" data-category="equity">股票</button>
              <button class="filter" data-category="index">指数</button>
            </div>
            <button class="primary" id="check">立即检测</button>
          </div>
        </div>
        <div class="source-list" id="sources"><div class="empty">正在读取数据源状态…</div></div>
      </article>

      <aside class="panel schedule">
        <h2>定时检测</h2>
        <div class="schedule-state">
          <div class="schedule-row"><span class="small-label">运行状态</span><span class="small-value" id="schedule-status">—</span></div>
          <div class="schedule-row"><span class="small-label">下次检测</span><span class="small-value" id="next-check">—</span></div>
        </div>
        <label for="interval">检测频率</label>
        <select id="interval">
          <option value="3600">每 1 小时</option>
          <option value="10800">每 3 小时</option>
          <option value="21600">每 6 小时</option>
          <option value="86400">每 24 小时</option>
        </select>
        <div class="schedule-actions">
          <button class="primary" id="save">启用 / 更新</button>
          <button class="secondary" id="disable">停用</button>
        </div>
        <div class="error" id="error"></div>
      </aside>
    </section>
    <footer>MARKET SERVER · PROVIDER OBSERVABILITY</footer>
  </main>

  <script>
    const byId = (id) => document.getElementById(id);
    const labels = { healthy: '健康', unhealthy: '异常', checking: '检测中', unknown: '未检测' };
    const categoryLabels = { equity: '股票', index: '指数' };
    let activeCategory = 'all';
    let latestBody = null;
    const formatTime = (value) => value ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '—';
    const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

    function render(body) {
      latestBody = body;
      const allSources = body.data || [];
      const sources = activeCategory === 'all'
        ? allSources
        : allSources.filter((source) => source.category === activeCategory);
      const healthy = sources.filter((source) => source.status === 'healthy').length;
      const unhealthy = sources.filter((source) => source.status === 'unhealthy').length;
      const latencies = sources.map((source) => source.latency_ms).filter((value) => value !== null);
      byId('total').textContent = sources.length;
      byId('healthy').textContent = healthy;
      byId('unhealthy').textContent = unhealthy;
      byId('latency').textContent = latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) + 'ms' : '—';
      byId('updated').textContent = '更新于 ' + formatTime(new Date().toISOString());
      byId('schedule-status').textContent = body.schedule.enabled ? '运行中 · ' + body.schedule.interval_seconds + 's' : '已停用';
      byId('next-check').textContent = formatTime(body.schedule.next_check_at);
      if ([3600, 10800, 21600, 86400].includes(body.schedule.interval_seconds)) byId('interval').value = String(body.schedule.interval_seconds);

      if (!sources.length) {
        byId('sources').innerHTML = '<div class="empty">尚未挂载数据源</div>';
        return;
      }
      byId('sources').innerHTML = sources.map((source) => {
        const error = source.error ? ' · ' + escapeHtml(source.error.message) : '';
        return '<div class="source" title="' + error + '">' +
          '<div class="source-mark">' + escapeHtml(source.source_id.slice(0, 2).toUpperCase()) + '</div>' +
          '<div><div class="source-name">' + escapeHtml(source.source_name) + '</div><div class="source-id">' + escapeHtml(source.provider_id + ' / ' + source.source_id) + '</div><div class="caps"><span class="category">' + categoryLabels[source.category] + '</span>' + source.capabilities.map((cap) => '<span class="cap">' + escapeHtml(cap) + '</span>').join('') + '</div></div>' +
          '<span class="status ' + source.status + '">' + labels[source.status] + '</span>' +
          '<span class="datum">' + (source.latency_ms === null ? '—' : source.latency_ms + ' ms') + '</span>' +
          '<span class="datum">' + formatTime(source.last_checked_at) + '</span>' +
        '</div>';
      }).join('');
    }

    byId('filters').addEventListener('click', (event) => {
      const button = event.target.closest('[data-category]');
      if (!button) return;
      activeCategory = button.dataset.category;
      document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button));
      if (latestBody) render(latestBody);
    });

    async function request(url, options) {
      const response = await fetch(url, options);
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || '请求失败');
      return body;
    }

    async function refresh() {
      try { render(await request('/v1/data-sources')); byId('error').textContent = ''; }
      catch (error) { byId('error').textContent = error.message; }
    }

    byId('check').addEventListener('click', async () => {
      byId('check').disabled = true; byId('check').textContent = '检测中…';
      try { render(await request('/v1/data-sources/check', { method: 'POST' })); }
      catch (error) { byId('error').textContent = error.message; }
      finally { byId('check').disabled = false; byId('check').textContent = '立即检测'; }
    });
    byId('save').addEventListener('click', async () => {
      try { render(await request('/v1/data-sources/schedule', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, interval_seconds: Number(byId('interval').value) }) })); }
      catch (error) { byId('error').textContent = error.message; }
    });
    byId('disable').addEventListener('click', async () => {
      try { render(await request('/v1/data-sources/schedule', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })); }
      catch (error) { byId('error').textContent = error.message; }
    });
    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`
