export const adminNavigationStyles = String.raw`
  .site-header { position:sticky; top:0; z-index:20; color:#dceae5; background:rgba(5,16,14,.94); border-bottom:1px solid rgba(136,190,173,.14); backdrop-filter:blur(18px); }
  .topbar { width:min(1240px,calc(100% - 40px)); height:68px; margin:auto; display:flex; align-items:center; gap:34px; }
  .brand { display:flex; align-items:center; gap:11px; color:#f2f8f5; text-decoration:none; font-weight:700; white-space:nowrap; letter-spacing:-.02em; }
  .brand-mark { width:34px; height:34px; display:grid; place-items:center; border-radius:10px; color:#061410; background:linear-gradient(135deg,#74dfbc,#3aa982); box-shadow:0 0 24px rgba(89,214,173,.18); font:700 11px "DM Mono",monospace; }
  .admin-nav { display:flex; align-self:stretch; gap:4px; }
  .admin-nav a { position:relative; display:flex; align-items:center; gap:8px; padding:0 15px; color:#8fa39c; text-decoration:none; font-size:13px; font-weight:600; transition:color .18s,background .18s; }
  .admin-nav a:hover { color:#e9f5f0; background:rgba(255,255,255,.025); }
  .admin-nav a.active { color:#6edbb7; }
  .admin-nav a.active::after { content:""; position:absolute; left:15px; right:15px; bottom:0; height:2px; background:#59d6ad; box-shadow:0 0 10px rgba(89,214,173,.65); }
  .nav-icon { width:20px; height:20px; display:grid; place-items:center; border:1px solid rgba(142,184,170,.18); border-radius:6px; font:500 10px "DM Mono",monospace; }
  .topbar-meta { margin-left:auto; display:flex; align-items:center; gap:12px; color:#73877f; font:500 10px "DM Mono",monospace; letter-spacing:.08em; }
  .account-link,.logout-button { color:#82968f; background:transparent; border:0; padding:6px 0; cursor:pointer; text-decoration:none; font:600 11px "Noto Sans SC",sans-serif; letter-spacing:0; }
  .account-link:hover,.logout-button:hover { color:#59d6ad; }
  .online-dot { width:7px; height:7px; border-radius:50%; background:#59d6ad; box-shadow:0 0 0 5px rgba(89,214,173,.08); }
  .utility-strip { border-top:1px solid rgba(136,190,173,.07); background:#081512; }
  .utility-inner { width:min(1240px,calc(100% - 40px)); height:30px; margin:auto; display:flex; align-items:center; gap:18px; color:#62776f; font:500 10px "DM Mono",monospace; }
  .utility-inner span + span::before { content:"/"; margin-right:18px; color:#30443d; }
  @media(max-width:700px) {
    .topbar { width:calc(100% - 24px); height:auto; min-height:62px; gap:12px; flex-wrap:wrap; padding-top:10px; }
    .brand { margin-right:auto; }
    .topbar-meta { display:none; }
    .admin-nav { width:100%; height:44px; order:3; }
    .admin-nav a { flex:1; justify-content:center; padding:0 8px; }
    .admin-nav a.active::after { left:10px; right:10px; }
    .utility-inner { width:calc(100% - 24px); overflow:hidden; white-space:nowrap; }
  }
`

export function adminNavigation(active: 'home' | 'sources' | 'sync' | 'keys' | 'account'): string {
  const item = (id: 'home' | 'sources' | 'sync' | 'keys' | 'account', href: string, icon: string, label: string) =>
    `<a${active === id ? ' class="active" aria-current="page"' : ''} href="${href}"><span class="nav-icon">${icon}</span>${label}</a>`
  return `<div class="site-header">
    <div class="topbar">
      <a class="brand" href="/admin"><span class="brand-mark">EVA</span><span>EVA 管理中心</span></a>
      <nav class="admin-nav" aria-label="管理目录">
        ${item('home', '/admin', '01', '数据首页')}
        ${item('sources', '/admin/data-sources', '02', '数据源')}
        ${item('sync', '/admin/data-sync', '03', '数据同步')}
        ${item('keys', '/admin/api-keys', '04', 'API 密钥')}
      </nav>
      <div class="topbar-meta"><span class="online-dot"></span>LOCAL SERVICE<a class="account-link" href="/admin/password">修改密码</a><button class="logout-button" id="admin-logout" type="button">退出</button></div>
    </div>
    <div class="utility-strip"><div class="utility-inner"><span>EVA</span><span>DATA OPERATIONS</span><span>LOCAL WAREHOUSE</span></div></div>
  </div><script>document.getElementById('admin-logout')?.addEventListener('click',async()=>{await fetch('/admin/session',{method:'DELETE'});location.assign('/admin/login')})</script>`
}
