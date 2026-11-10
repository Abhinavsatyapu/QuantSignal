(async function(){
  const $ = (id)=>document.getElementById(id);
  function redact(o){
    if(!o||typeof o!=='object') return o;
    const S=/password|secret|api[_-]?key|private[_-]?key|mnemonic|seed|token|authorization/i;
    const walk=(v)=>{
      if(Array.isArray(v)) return v.map(walk);
      if(!v||typeof v!=='object') return v;
      const out={};
      for(const [k,val] of Object.entries(v)) out[k]=S.test(k)?(val?'[redacted]':null):walk(val);
      return out;
    };
    return walk(o);
  }
  async function load(){
    const r = await fetch('/api/binance/status',{credentials:'same-origin'});
    if(r.status===401){ location.replace('/login?next=/futures-settings'); return; }
    if(!r.ok){ $('cur').textContent='Unable to load status ('+r.status+')'; return; }
    const j = await r.json();
    const s = j.settings||{};
    const f = s.entryFilters||{};
    $('modeLine').textContent = (j.dryRun?'DRY-RUN':'LIVE') + ' · signed orders ' + (s.allowSignedOrders?'ON':'OFF') + ' · capital $'+(s.capital??'—')+' · lev '+(s.leverage??'—')+'× · max '+(s.maxConcurrentPositions??4)+' · risk '+(s.riskPerTradePct??'—')+'%';
    $('cur').textContent = `Now: ${s.activePreset||'(custom)'} · ${s.interval||'—'} · ${s.signalMode||'—'} · usCashOnly=${!!f.usCashOnly} · noFriday=${!!f.noFridayEntry} · maxStopAtr=${f.maxStopAtr??'—'} · symbols ${s.universeCount||(s.assets||[]).length}`;
    $('raw').textContent = JSON.stringify(redact(s),null,2);
    const presets = s.studyPresets||{};
    const ids = Object.keys(presets);
    $('preset').innerHTML = (ids.length?ids:[]).map(id=>{
      const p=presets[id];
      const lab=(p&&p.label)||id;
      return `<option value="${id}" ${id===s.activePreset?'selected':''}>${lab}</option>`;
    }).join('') || '<option value="">(none)</option>';
  }
  $('save').onclick = async ()=>{
    $('msg').textContent='Saving…';
    const r = await fetch('/api/binance/settings',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({activePreset:$('preset').value})});
    const j = await r.json().catch(()=>({}));
    $('msg').textContent = r.ok ? 'Applied. Scanner will use the new interval/mode on next cycle. Bot stays dry-run until signed orders are enabled separately.' : (j.error||('HTTP '+r.status));
    load();
  };
  load();
})();
