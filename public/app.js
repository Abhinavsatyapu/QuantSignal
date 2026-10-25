const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
let rows=[];
function money(v){return Number.isFinite(+v)?`$${(+v).toFixed(2)}`:"—"} function rr(r){let risk=Math.abs(r.entry-r.stop),reward=Math.abs(r.target-r.entry);return risk?reward/risk:0}
function renderTable(filter="all"){if(!$("#signalTable"))return;let data=rows.filter(r=>filter==="all"||(filter==="buy"?r.openingConfirmation?.status==="confirmed_buy":r.openingConfirmation?.status!=="confirmed_buy"));$("#signalTable").innerHTML=data.map(r=>`<div class="signal-row"><div class="ticker"><span class="ticker-icon">${r.ticker.slice(0,2)}</span><div><b>${r.ticker}</b><small>${r.name||""}</small></div></div><div><span class="label ${r.openingConfirmation?.status==='confirmed_buy'?'':'watch'}">${r.openingConfirmation?.status==='confirmed_buy'?'BUY':'WATCH'}</span></div><div>${money(r.entry)}</div><div>${money(r.stop)}</div><div>${money(r.target)}</div><div><b>${rr(r).toFixed(2)}R</b></div></div>`).join(""); updateMetrics()}
function renderCards(data=rows){$("#allSignals").innerHTML=data.map(r=>`<article class="signal-card"><span class="label ${r.openingConfirmation?.status==='confirmed_buy'?'':'watch'}">${r.openingConfirmation?.statusLabel||'Signal'}</span><h3>${r.ticker}</h3><small>${r.name||''}</small><div class="levels"><div><span>ENTRY</span><b>${money(r.entry)}</b></div><div><span>STOP</span><b>${money(r.stop)}</b></div><div><span>TARGET</span><b>${money(r.target)}</b></div></div></article>`).join("")}
function updateMetrics(){}
$$('.nav').forEach(b=>b.onclick=()=>{if(!b.dataset.view)return;$$('.nav,.view').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('#'+b.dataset.view).classList.add('active');$('#pageTitle').textContent={dashboard:'Trading Dashboard',signals:'Trading Signals',news:'Global Market News',webhook:'Signal Stream & Webhook Lab',paper:'Paper Trading',gamma:'Gamma Book',hedge:'Live Hedge Compare',ratio:'1:2 Options + Futures',risk:'Risk Calculator',options:'Options Strategy Studio',autotrader:'Auto-Trader'}[b.dataset.view]||'QuantSignal';window.dispatchEvent(new CustomEvent('viewchange',{detail:b.dataset.view}));});
$('#renderTop').onclick=()=>document.querySelector('[data-view="webhook"]').click();setInterval(()=>$('#clock').textContent=new Date().toLocaleTimeString(),1000);

// Public, read-only market data. No account credentials are used.
const marketState={exchange:'hyperliquid-stocks',rows:[],lastFetched:0,nextFetch:0,busy:false,generation:0,failed:false};
const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const positiveNumber=v=>Number.isFinite(Number(v))&&Number(v)>0;
function normalizeHyperliquid(payload){
 if(!Array.isArray(payload)||!Array.isArray(payload[0]?.universe)||!Array.isArray(payload[1]))throw Error('Unexpected Hyperliquid response.');
 return payload[0].universe.flatMap((asset,i)=>{const ctx=payload[1][i];if(asset.isDelisted||!ctx||!positiveNumber(ctx.markPx))return [];return [{symbol:asset.name,price:Number(ctx.markPx),change:positiveNumber(ctx.prevDayPx)?(Number(ctx.markPx)/Number(ctx.prevDayPx)-1)*100:null,volume:Number(ctx.dayNtlVlm),funding:Number.isFinite(Number(ctx.funding))&&ctx.funding!=null?Number(ctx.funding)*100:null}];});
}
function normalizeBinance(payload){
 if(!Array.isArray(payload))throw Error('Unexpected Binance response.');
 return payload.filter(r=>r.symbol?.endsWith('USDT')&&positiveNumber(r.lastPrice)&&Number(r.quoteVolume)>0).map(r=>({symbol:r.symbol.slice(0,-4),price:Number(r.lastPrice),change:positiveNumber(r.openPrice)?(Number(r.lastPrice)/Number(r.openPrice)-1)*100:null,volume:Number(r.quoteVolume),funding:null}));
}
function quotePrice(v){return Number.isFinite(v)?v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:v<1?8:v<100?4:2}):'—';}
function percent(v){return Number.isFinite(v)?`${v>=0?'+':''}${v.toFixed(2)}%`:'—';}
function renderMarkets(){
 const query=$('#marketSearch').value.trim().toUpperCase(),stockMode=marketState.exchange==='hyperliquid-stocks',filter=$('#stockFilter').value;$('#stockFilter').hidden=!stockMode;const rows=marketState.rows.filter(r=>(!stockMode||filter==='all'||r.kind===filter)&&[r.symbol,r.name||''].some(s=>s.toUpperCase().includes(query)));
 $('#marketRows').innerHTML=rows.length?rows.map(r=>`<tr><td><b>${escapeHtml(r.symbol)}</b>${r.dex?'<small class="market-detail">'+escapeHtml(r.name)+' · '+escapeHtml(r.kind==='us-stock'?'US stock perp':r.kind==='etf'?'ETF perp':'Other equity perp')+'</small>':''}<button class="analyze-market" data-symbol="${escapeHtml(r.symbol)}">Analyze ↗</button></td><td>${quotePrice(r.price)}</td><td class="${r.change>=0?'positive':'negative'}">${percent(r.change)}</td><td>${Number.isFinite(r.volume)?r.volume.toLocaleString('en-US',{notation:'compact',maximumFractionDigits:2}):'—'}</td><td>${r.funding===null?'—':r.funding.toFixed(5)+'%'}</td></tr>`).join(''):'<tr><td colspan="5">No matching market data.</td></tr>';
 $('#marketCount').textContent=stockMode?rows.length:(marketState.rows.length||'—');$('#marketRows').querySelectorAll('.analyze-market').forEach(b=>b.onclick=()=>{window.dispatchEvent(new CustomEvent('analyzemarket',{detail:b.dataset.symbol}));});
 const highlighted=stockMode?rows.slice(0,2):['BTC','ETH'].map(symbol=>marketState.rows.find(r=>r.symbol===symbol));
 for(let i=0;i<2;i++){const r=highlighted[i],key=i?'eth':'btc';$('#'+(i?'quoteTwoLabel':'quoteOneLabel')).textContent=(r?.symbol||(i?'ETH':'BTC'))+' price';$('#'+key+'Price').textContent=quotePrice(r?.price);$('#'+key+'Change').textContent='24-hour change: '+percent(r?.change);}
 $('#marketSource').textContent=stockMode?'Hyperliquid · HIP-3 stock perps':marketState.exchange==='hyperliquid'?'Hyperliquid · perpetuals · USD':'Binance · spot · USDT';
 $('#priceHeading').textContent=marketState.exchange==='binance'?'Last trade · USDT':'Mark price · USD';
 $('#lastUpdated').textContent='Last fetched: '+(marketState.lastFetched?new Date(marketState.lastFetched).toLocaleTimeString():'—');
}
function updateFeedStatus(){
 const stale=marketState.lastFetched&&Date.now()-marketState.lastFetched>60000;
 $('#feedStatus').textContent=marketState.busy?'Fetching exchange data…':marketState.failed||stale?(marketState.lastFetched?'STALE · last successful quotes retained':'Unavailable · no prices loaded'):marketState.lastFetched?'LIVE · exchange API':'Connecting…';
 $('#feedStatus').className=marketState.failed||stale?'negative':'positive';
 $('#nextRefresh').textContent='Next refresh in '+Math.max(0,Math.ceil((marketState.nextFetch-Date.now())/1000))+'s · 30-second interval';
}
async function fetchMarkets(){
 if(marketState.busy)return;
 const generation=marketState.generation,exchange=marketState.exchange;marketState.busy=true;$('#refreshMarket').disabled=true;updateFeedStatus();
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),exchange==='hyperliquid-stocks'?40000:12000);
 try{
 const stockMode=exchange==='hyperliquid-stocks';const response=await fetch(stockMode?'/api/stocks':exchange==='hyperliquid'?'https://api.hyperliquid.xyz/info':'https://data-api.binance.vision/api/v3/ticker/24hr?type=MINI',exchange==='hyperliquid'?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'metaAndAssetCtxs'}),signal:controller.signal,cache:'no-store'}:{signal:controller.signal,cache:'no-store'});
 if(!response.ok)throw Error('Exchange API returned HTTP '+response.status);
 const payload=await response.json();const rows=stockMode?payload.rows:exchange==='hyperliquid'?normalizeHyperliquid(payload):normalizeBinance(payload);
 if(!Array.isArray(rows))throw Error('Invalid stock market response');
 if(!rows.length)throw Error('Exchange returned no valid markets.');
 if(generation!==marketState.generation)return;
 const priority=['BTC','ETH','SOL','HYPE'];rows.sort((a,b)=>{const pa=priority.includes(a.symbol)?priority.indexOf(a.symbol):99,pb=priority.includes(b.symbol)?priority.indexOf(b.symbol):99;return pa-pb||b.volume-a.volume;});
 marketState.rows=rows;marketState.lastFetched=Date.now();marketState.failed=false;$('#marketError').textContent=stockMode&&payload.errors?.length?'Some builder venues unavailable: '+payload.errors.join(', '):'';if(stockMode)window.dispatchEvent(new CustomEvent('stockcatalog',{detail:payload}));renderMarkets();
 }catch(error){if(generation===marketState.generation){marketState.failed=true;$('#marketError').textContent=(error.name==='AbortError'?'Exchange request timed out.':error.message||'Unable to reach exchange API.')+' Automatic retry in 30 seconds. You can try the other exchange.';}}
 finally{clearTimeout(timeout);marketState.busy=false;$('#refreshMarket').disabled=false;marketState.nextFetch=Date.now()+30000;updateFeedStatus();if(generation!==marketState.generation)fetchMarkets();}
}
$('#exchange').onchange=e=>{marketState.exchange=e.target.value;marketState.generation++;marketState.rows=[];marketState.lastFetched=0;marketState.failed=false;$('#marketError').textContent='';renderMarkets();fetchMarkets();};
$('#marketSearch').oninput=renderMarkets;$('#stockFilter').onchange=renderMarkets;$('#openStocks').onclick=()=>{document.querySelector('[data-view="dashboard"]').click();$('#exchange').value='hyperliquid-stocks';$('#exchange').dispatchEvent(new Event('change'));};
$('#refreshMarket').onclick=fetchMarkets;
setInterval(()=>{updateFeedStatus();if(!marketState.busy&&Date.now()>=marketState.nextFetch)fetchMarkets();},1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()>=marketState.nextFetch)fetchMarkets();});
fetchMarkets();
