(async function(){
  const tb=document.querySelector('#tbl tbody');
  try{
    const r=await fetch('/api/strategy/runs?limit=30',{credentials:'same-origin'});
    if(!r.ok){ document.getElementById('note').textContent='Could not load runs ('+r.status+'). Use Builder history.'; return; }
    const rows=await r.json();
    const list=Array.isArray(rows)?rows:(rows.runs||[]);
    document.getElementById('note').textContent=list.length? (list.length+' recent runs') : 'No saved runs yet.';
    tb.innerHTML=list.slice(0,30).map(x=>{
      const when=x.ts||x.createdAt||x.created_at||'—';
      const t=typeof when==='number'?new Date(when).toLocaleString():String(when);
      return `<tr><td>${t}</td><td>${x.ticker||x.symbol||'—'}</td><td>${(x.label||x.note||x.status||'').toString().slice(0,80)}</td></tr>`;
    }).join('')||'<tr><td colspan="3">Empty</td></tr>';
  }catch(e){ document.getElementById('note').textContent=e.message; }
})();
