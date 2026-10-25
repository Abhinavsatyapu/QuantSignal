// Auto-Trader console: talks to the always-on server engine (/api/autotrader/*).
(function(){
const TK='quantsignal.adminToken';
const at={token:localStorage.getItem(TK)||'',status:null,busy:false,timer:null,visible:false,formDirty:false};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=v=>Number.isFinite(+v)&&v!==null?(v<0?'-':'')+'$'+Math.abs(+v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
const px=v=>Number.isFinite(+v)&&v!==null?(+v).toLocaleString('en-US',{maximumFractionDigits:+v<1?6:+v<100?4:2}):'—';
const signed=v=>Number.isFinite(+v)?`<span class="${v>0?'positive':v<0?'negative':''}">${v>0?'+':''}${usd(v)}</span>`:'—';
const t=ms=>ms?new Date(ms).toLocaleString([], {month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const ago=ms=>{if(!ms)return '—';const s=Math.round((Date.now()-ms)/1000);return s<60?s+'s ago':s<3600?Math.round(s/60)+'m ago':Math.round(s/3600)+'h ago';};
const side=d=>`<span class="side-${String(d).toLowerCase()==='long'?'long':'short'}">${esc(d)}</span>`;
const q=s=>document.querySelector(s);

async function api(path,opt={}){
  const r=await fetch('/api/autotrader'+path,{...opt,headers:{'Content-Type':'application/json','Authorization':'Bearer '+at.token,...(opt.headers||{})},cache:'no-store'});
  const data=await r.json().catch(()=>({error:'Invalid server response'}));
  if(r.status===401){showAuth('Token rejected — check ADMIN_TOKEN in .env');throw Error('unauthorized');}
  if(!r.ok)throw Error(data.error||('HTTP '+r.status));
  return data;
}
function showAuth(msg){q('#atAuth').hidden=false;q('#atAuthError').textContent=msg||'';setChip('warn','LOCKED','enter admin token');}
function setChip(kind,label,sub){const c=q('#engineChip');c.querySelector('.dot').className='dot '+kind;c.querySelector('b').textContent=label;c.querySelector('em').textContent=sub;q('#sideDot').className='dot '+kind;q('#sideEngine').textContent='Auto-Trader · '+label;q('#sideEngineSub').textContent=sub;}

function renderStatus(s){
  const live=s.mode==='live',kill=s.killSwitch,net=s.network.toUpperCase();
  setChip(kill?'off':'on',kill?'PAUSED':'RUNNING',net+' · '+(live?'LIVE':'DRY-RUN'));
  q('#atBadges').innerHTML=[
    `<span class="badge lg ${s.running?'':'bad'}">● ${s.running?'Engine running':'Engine stopped'}</span>`,
    `<span class="badge lg ${s.network==='mainnet'?'bad':'info'}">${net}</span>`,
    `<span class="badge lg ${live?'':'warn'}">${live?'LIVE ORDERS':'DRY-RUN · no orders sent'}</span>`,
    kill?`<span class="badge lg bad">TRADING PAUSED</span>`:`<span class="badge lg">TRADING ACTIVE</span>`,
    s.autoTrade?'':`<span class="badge lg warn">AUTO-EXECUTE OFF</span>`,
    `<span class="badge lg muted">Up since ${t(s.startedAt)}</span>`].join('');
  const acctLine=s.accountAddress?`account ${s.accountAddress}`:'no HL_ACCOUNT_ADDRESS';
  q('#atSummary').innerHTML=`API: <code>${esc(s.apiUrl)}</code> · ${s.keyPresent?'API-wallet key loaded'+(s.agentAddress?` (<code>${esc(s.agentAddress.slice(0,6)+'…'+s.agentAddress.slice(-4))}</code>${s.agentRole?' · role: '+esc(s.agentRole):''})`:''):'no API-wallet key'} · ${esc(acctLine)}. Runs 24/7 on the server; closing this page does not stop it.`;
  q('#atProblems').textContent=[...(s.problems||[]),s.pausedReason,s.accountError?'Account: '+s.accountError:''].filter(Boolean).join(' · ');
  const k=q('#atKill');k.disabled=false;k.classList.toggle('resume',kill);k.querySelector('.kill-label').textContent=kill?'RESUME TRADING':'PAUSE TRADING';k.querySelector('small').textContent=kill?'Kill switch ON':'Kill switch';
  q('#atKillNote').textContent=kill?'New entries are blocked. Press to resume automated execution.':'Blocks every new entry instantly. Existing SL/TP orders stay in place.';
  const a=s.account||{};
  q('#atEquity').textContent=usd(a.equity);
  q('#atEquitySub').textContent=a.mode==='dry_run'?`Simulated (base ${usd(a.simulatedBase)})${a.referenceAccount?' · real testnet '+usd(a.referenceAccount.equity):''}`:(a.withdrawable!=null?'Withdrawable '+usd(a.withdrawable):'—');
  q('#atDayPnl').innerHTML=Number.isFinite(a.dayPnl)?signed(a.dayPnl):'—';
  q('#atDayPnlSub').textContent=Number.isFinite(a.dayPnlPct)?`${a.dayPnlPct.toFixed(2)}% · limit −${s.risk.dailyLossLimitPct}% auto-pauses`:'—';
  const pos=a.positions||[];
  q('#atOpenCount').textContent=pos.length;q('#atOpenSub').textContent=`Max ${s.risk.maxConcurrentPositions} · ${s.risk.maxLeverage}× max leverage`;
  const sc=s.scanner;q('#atScanState').textContent=sc.enabled?(sc.busy?'Scanning…':'Active'):'Disabled';
  q('#atScanSub').textContent=`${sc.assets.join(', ')} · ${sc.interval} · last ${ago(sc.lastScanAt)} · next ${sc.nextScanAt?new Date(sc.nextScanAt).toLocaleTimeString():'—'}`;
  q('#atPosNote').textContent=a.mode==='dry_run'?'Simulated positions (dry-run)':'Live from Hyperliquid';
  q('#atPositions').innerHTML=pos.length?pos.map(p=>`<tr><td><b>${esc(p.coin)}</b></td><td>${side(p.direction)}</td><td class="num">${px(p.size)}</td><td class="num">${px(p.entryPx)}</td><td class="num">${px(p.markPx??(p.positionValue/p.size))}</td><td class="num">${p.stopPx?px(p.stopPx)+' / '+px(p.tpPx):'on exchange'}</td><td class="num">${signed(p.unrealizedPnl)}</td><td><button class="danger sm" data-close="${esc(p.coin)}">Close</button></td></tr>`).join(''):'<tr><td colspan="8" class="empty">No open positions.</td></tr>';
  q('#atPositions').querySelectorAll('[data-close]').forEach(b=>b.onclick=async()=>{if(!confirm('Close '+b.dataset.close+' at market?'))return;b.disabled=true;try{await api('/close',{method:'POST',body:JSON.stringify({coin:b.dataset.close})});}catch(e){alert(e.message)}refresh();});
  q('#atNetBadge').textContent=net+(live?' · LIVE':' · DRY-RUN');q('#atNetBadge').className='badge '+(s.network==='mainnet'?'bad':'info');
  q('#atWebhookUrl').textContent=location.origin+'/webhook';
  q('#atStats').textContent=s.stats?.n?`${s.stats.n} closed · ${s.stats.wins} wins · net ${usd(s.stats.pnl)}`:'No closed trades yet';
  if(!at.formDirty)fillForm(s);
}
function fillForm(s){const f=q('#atSettings');for(const el of f.elements){if(!el.name)continue;const [g,k]=el.name.split('.');const v=(g==='trading'?{autoTrade:s.autoTrade}:g==='webhook'?s.webhook:g==='scanner'?s.scanner:s.risk)[k];if(el.type==='checkbox')el.checked=!!v;else el.value=Array.isArray(v)?v.join(','):v??'';}}
function readForm(){const out={risk:{},scanner:{},webhook:{},trading:{}};for(const el of q('#atSettings').elements){if(!el.name)continue;const [g,k]=el.name.split('.');out[g][k]=el.type==='checkbox'?el.checked:el.type==='number'?Number(el.value):el.value;}return out;}

function renderLists(signals,trades,events,scans){
  q('#atSignals').innerHTML=signals.length?signals.map(s=>`<tr><td class="num">${s.id}</td><td>${t(s.ts)}</td><td><span class="badge ${s.source==='webhook'?'info':'muted'}">${esc(s.source)}</span></td><td><b>${esc(s.coin)}</b>${s.interval?` <small style="display:inline">${esc(s.interval)}</small>`:''}</td><td>${side(s.direction)}</td><td class="num">${px(s.entry)}</td><td class="num">${px(s.stop)}</td><td class="num">${px(s.tp)}</td><td><span class="badge ${s.status==='executed'?'':s.status==='dry_run'?'info':s.status==='rejected'?'warn':'bad'}">${esc(s.status.replace('_','-'))}</span><small>${esc(s.reason||'')}</small></td></tr>`).join(''):'<tr><td colspan="9" class="empty">No signals yet. The scanner evaluates each completed candle; TradingView alerts appear here instantly.</td></tr>';
  q('#atTrades').innerHTML=trades.length?trades.map(x=>`<tr><td class="num">${x.id}</td><td>${t(x.ts)}</td><td><span class="badge ${x.mode==='live'?'':'warn'}">${x.mode==='live'?'LIVE':'DRY-RUN'}</span><small>${esc(x.network)}</small></td><td><b>${esc(x.coin)}</b></td><td>${side(x.direction)}</td><td class="num">${px(x.size)}</td><td class="num">${px(x.entry_px)}</td><td class="num">${px(x.stop_px)} / ${px(x.tp_px)}</td><td class="num">${usd(x.notional)}<small>${x.leverage}×</small></td><td><span class="badge ${x.status==='open'?'info':'muted'}">${esc(x.status)}</span>${x.exit_reason?`<small>${esc(x.exit_reason)}${x.exit_px?' @ '+px(x.exit_px):''}</small>`:''}</td><td class="num">${x.pnl==null?'—':signed(x.pnl)}</td></tr>`).join(''):'<tr><td colspan="11" class="empty">No trades yet.</td></tr>';
  q('#atEvents').innerHTML=events.length?events.map(e=>`<p class="lv-${esc(e.level)}"><time>${new Date(e.ts).toLocaleTimeString()}</time>${esc(e.msg)}</p>`).join(''):'<p class="empty">No events.</p>';
  q('#atScans').innerHTML=scans.length?scans.map(r=>{const a=r.data||{};const st=a.direction||'—';return `<tr><td><b>${esc(r.coin)}</b><small style="display:inline"> ${esc(r.interval)}</small></td><td><span class="label ${st==='LONG'?'':st==='SHORT'?'short':'watch'}">${esc(st)}</span></td><td class="num">${a.score??'—'}/8</td><td class="num">${px(a.entry)}</td><td class="num">${a.stop?px(a.stop):'—'}</td><td>${a.closedAt?new Date(a.closedAt+1).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'—'}<small>${esc(a.source||'')} candles · scanned ${ago(r.ts)}</small></td></tr>`;}).join(''):'<tr><td colspan="6" class="empty">Waiting for the first scan…</td></tr>';
}
let marketsAt=0;
function renderMarkets(d){
  q('#atSession').textContent=d.session.label;q('#atSession').className='badge '+(d.session.open?'':'warn');
  const tradable=d.rows.filter(r=>r.trading).length;
  q('#atMarketsNote').innerHTML=`Dex <code>${esc(d.dex)}</code> · ${tradable}/${d.rows.length} watchlist markets listed on <b>${esc(d.network)}</b> (${d.tradingListed.length} live ${esc(d.dex)} markets there in total). Signals use read-only mainnet candles; orders go only to ${esc(d.network)}. Unlisted or illiquid markets are rejected, never routed to mainnet.`;
  q('#atMarkets').innerHTML=d.rows.map(r=>{const m=r.mainnet,t=r.trading;return `<tr><td><b>${esc(r.coin)}</b></td><td class="num">${m?px(m.markPx):'—'}</td><td class="num">${m?'$'+Math.round(m.dayNtlVlm).toLocaleString():'—'}</td><td>${t?`<span class="badge">LISTED</span>`:`<span class="badge bad">NOT LISTED</span>`}</td><td class="num">${t?px(t.markPx):'—'}</td><td class="num">${t&&t.bid?px(t.bid.px)+' <small style="display:inline">×'+t.bid.sz+'</small>':'<span class="negative">none</span>'}</td><td class="num">${t&&t.ask?px(t.ask.px)+' <small style="display:inline">×'+t.ask.sz+'</small>':'<span class="negative">none</span>'}</td><td class="num">${t?t.maxLeverage+'×':'—'}</td><td>${t?esc(t.marginMode):'—'}</td></tr>`;}).join('');
}
async function refresh(){
  if(!at.token){showAuth('');return;}
  if(at.busy)return;at.busy=true;
  try{const s=await api('/status');at.status=s;q('#atAuth').hidden=true;renderStatus(s);
    if(at.visible&&Date.now()-marketsAt>30000){marketsAt=Date.now();api('/markets').then(renderMarkets).catch(e=>{q('#atMarketsNote').textContent='Market availability unavailable: '+e.message;});}
    if(at.visible){const [sig,tr,ev,sc]=await Promise.all([api('/signals?limit=40'),api('/trades?limit=40'),api('/events?limit=80'),api('/scans')]);renderLists(sig,tr,ev,sc);}
  }catch(e){if(e.message!=='unauthorized')setChip('off','OFFLINE',e.message.slice(0,40));}
  finally{at.busy=false;}
}
q('#atTokenSave').onclick=()=>{at.token=q('#atToken').value.trim();localStorage.setItem(TK,at.token);q('#atAuthError').textContent='';refresh();};
q('#atToken').addEventListener('keydown',e=>{if(e.key==='Enter')q('#atTokenSave').click();});
q('#atKill').onclick=async()=>{const on=!at.status?.killSwitch;if(!on&&!confirm('Resume automated trading on '+(at.status?.network||'')+'?'))return;q('#atKill').disabled=true;try{await api('/kill',{method:'POST',body:JSON.stringify({on,reason:on?'Paused from Auto-Trader console':undefined})});}catch(e){alert(e.message)}refresh();};
q('#atSettings').addEventListener('input',()=>{at.formDirty=true;q('#atSaveStatus').textContent='Unsaved changes';});
q('#atSave').onclick=async()=>{q('#atSave').disabled=true;try{await api('/config',{method:'POST',body:JSON.stringify(readForm())});at.formDirty=false;q('#atSaveStatus').textContent='Saved '+new Date().toLocaleTimeString();}catch(e){q('#atSaveStatus').textContent='Error: '+e.message;}finally{q('#atSave').disabled=false;refresh();}};
q('#atScanNow').onclick=async()=>{const b=q('#atScanNow');b.disabled=true;b.textContent='Scanning…';try{await api('/scan-now',{method:'POST'});}catch(e){alert(e.message)}b.disabled=false;b.textContent='Scan now';refresh();};

// top bar + navigation
q('#renderTop').onclick=()=>document.querySelector('[data-view="autotrader"]').click();
q('#menuBtn').onclick=()=>document.body.classList.toggle('nav-open');q('#scrim').onclick=()=>document.body.classList.remove('nav-open');
document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>document.body.classList.remove('nav-open')));
window.addEventListener('viewchange',e=>{at.visible=e.detail==='autotrader';if(at.visible)refresh();});
const paths={'/autotrader':'autotrader','/options':'options','/gamma':'gamma','/ratio':'ratio','/hedge':'hedge'};
if(paths[location.pathname])document.querySelector(`[data-view="${paths[location.pathname]}"]`).click();
setInterval(()=>{if(!document.hidden)refresh();},5000);refresh();
})();
