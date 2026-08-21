import { adminNavigation, adminNavigationStyles } from './admin-navigation.js'

export const apiKeyDashboardHtml = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API 密钥 · Market Console</title><style>
  *{box-sizing:border-box}body{margin:0;color:#dceae5;background:#07110f;font-family:"Noto Sans SC",system-ui,sans-serif}${adminNavigationStyles}
  main{width:min(1000px,calc(100% - 40px));margin:48px auto}.eyebrow{color:#59d6ad;font:600 11px monospace;letter-spacing:.12em}h1{margin:8px 0;font-size:32px}.lead{color:#82968f;margin:0 0 30px}
  .panel{padding:24px;border:1px solid #1d342d;border-radius:14px;background:#0b1916;margin-bottom:20px}.create{display:flex;gap:12px}input{flex:1;padding:12px 14px;border:1px solid #29473d;border-radius:9px;color:#eef8f4;background:#081310;font:inherit}button{padding:11px 16px;border:0;border-radius:9px;color:#061410;background:#59d6ad;font-weight:700;cursor:pointer}.danger{color:#ff968b;background:#2b1716}
  table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:14px 10px;border-bottom:1px solid #193029}th{color:#70877f;font-size:12px}code{color:#8ee7ca}.empty{padding:24px 10px;color:#70877f}.notice{display:none;padding:18px;margin-top:18px;border:1px solid #4d806e;border-radius:10px;background:#102c24}.notice code{display:block;margin:10px 0;padding:12px;overflow-wrap:anywhere;background:#07110f}.hint{color:#82968f;font-size:13px}
  @media(max-width:700px){main{width:calc(100% - 24px)}.create{flex-direction:column}.created{display:none}}
</style></head><body>${adminNavigation('keys')}<main>
  <div class="eyebrow">ACCESS CONTROL / API KEYS</div><h1>API 密钥</h1><p class="lead">为 CLI 创建独立凭据。密钥只在创建时显示一次，服务端仅保存哈希。</p>
  <section class="panel"><form class="create" id="create-form"><input id="key-name" maxlength="80" required placeholder="密钥名称，例如：research-mac"><button type="submit">创建密钥</button></form><div class="notice" id="notice"><strong>请立即保存此密钥</strong><code id="created-key"></code><span class="hint">关闭后将无法再次查看；如遗失，请撤销后重建。</span></div></section>
  <section class="panel"><table><thead><tr><th>名称</th><th>前缀</th><th class="created">创建时间</th><th></th></tr></thead><tbody id="key-list"></tbody></table><div class="empty" id="empty">暂无 API 密钥</div></section>
</main><script>
const list=document.getElementById('key-list'),empty=document.getElementById('empty');
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){const r=await fetch('/v1/api-keys');const body=await r.json();list.innerHTML=(body.data||[]).map(k=>'<tr><td>'+esc(k.name)+'</td><td><code>'+esc(k.prefix)+'…</code></td><td class="created">'+esc(new Date(k.created_at).toLocaleString())+'</td><td><button class="danger" data-id="'+esc(k.id)+'">撤销</button></td></tr>').join('');empty.style.display=list.children.length?'none':'block'}
document.getElementById('create-form').addEventListener('submit',async e=>{e.preventDefault();const r=await fetch('/v1/api-keys',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:document.getElementById('key-name').value})});const body=await r.json();if(!r.ok){alert(body.detail||'创建失败');return}document.getElementById('created-key').textContent=body.data.key;document.getElementById('notice').style.display='block';e.target.reset();await load()});
list.addEventListener('click',async e=>{const id=e.target.dataset?.id;if(!id||!confirm('确认撤销此密钥？使用它的 CLI 将立即无法访问。'))return;await fetch('/v1/api-keys/'+encodeURIComponent(id),{method:'DELETE'});await load()});load();
</script></body></html>`
