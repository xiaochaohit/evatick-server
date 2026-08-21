const pageStyles = String.raw`
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;600;700&display=swap');
  :root { --ink:#e7f1ed; --muted:#82968f; --paper:#07110f; --card:rgba(13,27,23,.92); --line:rgba(151,199,183,.14); --green:#59d6ad; --red:#ee806c; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; color:var(--ink); font-family:"Noto Sans SC",sans-serif; background:radial-gradient(circle at 18% 8%,rgba(47,142,111,.2),transparent 32rem),radial-gradient(circle at 88% 78%,rgba(41,112,90,.12),transparent 30rem),var(--paper); }
  body::before { content:""; position:fixed; inset:0; pointer-events:none; background-image:linear-gradient(rgba(137,193,175,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(137,193,175,.03) 1px,transparent 1px); background-size:32px 32px; mask-image:linear-gradient(black,transparent 88%); }
  .card { position:relative; width:min(430px,100%); padding:34px; border:1px solid var(--line); border-radius:24px; background:var(--card); box-shadow:0 28px 80px rgba(0,0,0,.34); backdrop-filter:blur(20px); }
  .brand { display:flex; align-items:center; gap:12px; margin-bottom:34px; font-weight:700; }
  .mark { width:38px; height:38px; display:grid; place-items:center; border-radius:11px; color:#061410; background:linear-gradient(135deg,#74dfbc,#3aa982); font:700 11px "DM Mono",monospace; box-shadow:0 0 28px rgba(89,214,173,.2); }
  .eyebrow { margin-bottom:9px; color:var(--green); font:500 11px "DM Mono",monospace; letter-spacing:.16em; }
  h1 { margin:0; font-size:32px; letter-spacing:-.035em; }
  .subtitle { margin:10px 0 28px; color:var(--muted); font-size:13px; line-height:1.7; }
  label { display:block; margin:16px 0 8px; color:var(--muted); font-size:12px; }
  input { width:100%; padding:12px 13px; color:var(--ink); background:#13231d; border:1px solid transparent; border-radius:11px; outline:none; font:500 14px "DM Mono",monospace; }
  input:focus { border-color:var(--green); background:#172a22; }
  button { width:100%; margin-top:24px; padding:13px; border:0; border-radius:11px; color:#07130f; background:var(--green); cursor:pointer; font:700 13px "Noto Sans SC",sans-serif; }
  button:disabled { opacity:.55; cursor:wait; }
  .error { min-height:20px; margin-top:13px; color:var(--red); font-size:12px; line-height:1.5; }
  .success { color:var(--green); }
  .back { display:inline-block; margin-top:18px; color:var(--muted); font-size:12px; text-decoration:none; }
  .back:hover { color:var(--green); }
`

function document(title: string, content: string, script: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Market Server</title><style>${pageStyles}</style></head><body>${content}<script>${script}</script></body></html>`
}

export function adminLoginHtml(next: string): string {
  return document('登录', `<main class="card"><div class="brand"><span class="mark">MC</span><span>Market Console</span></div><div class="eyebrow">ADMIN ACCESS</div><h1>登录管理后台</h1><p class="subtitle">请输入管理员账号与密码。会话仅保存在安全的浏览器 Cookie 中。</p><form id="form"><label for="username">账号</label><input id="username" name="username" autocomplete="username" autofocus required><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><button id="submit" type="submit">登录</button><div class="error" id="message" role="alert"></div></form></main>`, `
    const form=document.getElementById('form'),button=document.getElementById('submit'),message=document.getElementById('message');
    form.addEventListener('submit',async(event)=>{event.preventDefault();button.disabled=true;message.textContent='';try{const response=await fetch('/admin/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:form.username.value,password:form.password.value,next:${JSON.stringify(next)}})});const body=await response.json();if(!response.ok)throw new Error(body.detail||'登录失败');location.assign(body.data.next);}catch(error){message.textContent=error.message;}finally{button.disabled=false;}});
  `)
}

export const adminPasswordHtml = document('修改密码', `<main class="card"><div class="brand"><span class="mark">MC</span><span>Market Console</span></div><div class="eyebrow">ACCOUNT SECURITY</div><h1>修改密码</h1><p class="subtitle">新密码至少 8 个字符。修改成功后，其他已登录会话将立即失效。</p><form id="form"><label for="current">当前密码</label><input id="current" type="password" autocomplete="current-password" required><label for="next">新密码</label><input id="next" type="password" minlength="8" maxlength="256" autocomplete="new-password" required><label for="confirm">确认新密码</label><input id="confirm" type="password" minlength="8" maxlength="256" autocomplete="new-password" required><button id="submit" type="submit">保存新密码</button><div class="error" id="message" role="alert"></div></form><a class="back" href="/admin">← 返回管理后台</a></main>`, `
  const form=document.getElementById('form'),button=document.getElementById('submit'),message=document.getElementById('message');
  form.addEventListener('submit',async(event)=>{event.preventDefault();message.classList.remove('success');if(form.next.value!==form.confirm.value){message.textContent='两次输入的新密码不一致';return;}button.disabled=true;message.textContent='';try{const response=await fetch('/admin/password',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({current_password:form.current.value,new_password:form.next.value})});const body=await response.json();if(!response.ok)throw new Error(body.detail||'密码修改失败');form.reset();message.classList.add('success');message.textContent='密码已修改，其他会话已退出。';}catch(error){message.textContent=error.message;}finally{button.disabled=false;}});
`)
