'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const STORE = 'corolla-decisions-v1';
  const CONFIG = 'corolla-github-config-v1';
  const statuses = new Set(['new', 'review', 'interesting', 'rejected']);
  let offers = [];
  let decisions = loadLocal();
  let token = ''; // Never persist token in localStorage, repo, or exported JSON.
  let remoteSha = null;
  let connected = false;
  let saveTimer = null;
  let pending = Promise.resolve();

  function loadLocal() {
    try { const parsed = JSON.parse(localStorage.getItem(STORE) || '{}'); return parsed && typeof parsed === 'object' ? parsed : {}; }
    catch { return {}; }
  }
  function persist() { localStorage.setItem(STORE, JSON.stringify(decisions)); }
  function message(text, type = '') {
    $('storageMessage').textContent = text;
    $('storageMessage').className = 'storage-message ' + type;
  }
  function normalizeUrl(raw) {
    try {
      const u = new URL(raw);
      u.hash = '';
      u.hostname = u.hostname.replace(/^www\./, '').toLowerCase();
      u.pathname = u.pathname.replace(/\/$/, '');
      [...u.searchParams.keys()].forEach(k => { if (k.toLowerCase().startsWith('utm_')) u.searchParams.delete(k); });
      u.searchParams.sort();
      return u.toString();
    } catch { return String(raw || ''); }
  }
  function identities(offer) {
    const values = [offer.id];
    if (offer.vin) values.push('vin:' + offer.vin.toUpperCase());
    for (const id of offer.listingIds || []) values.push('listing:' + id.toLowerCase());
    for (const link of offer.urls || []) values.push('url:' + normalizeUrl(link.url));
    return [...new Set(values.filter(Boolean))];
  }
  function findDecision(offer) {
    const ids = identities(offer);
    const candidates = Object.entries(decisions).filter(([key, d]) =>
      ids.includes(key) || (d.identities || []).some(id => ids.includes(id))
    );
    candidates.sort((a,b) => (b[1].updatedAt || '').localeCompare(a[1].updatedAt || ''));
    return candidates[0]?.[1] || null;
  }
  function statusOf(offer) { return findDecision(offer)?.status || 'new'; }
  function safeStatus(s) { return statuses.has(s) ? s : 'new'; }
  function update(offer, patch) {
    const previous = findDecision(offer) || {};
    const identity = identities(offer);
    const key = previous.key || offer.id;
    decisions[key] = {
      ...previous, ...patch, key,
      identities: [...new Set([...(previous.identities || []), ...identity])],
      title: offer.title,
      updatedAt: new Date().toISOString()
    };
    persist();
    scheduleSave();
  }
  function buildCard(offer) {
    const holder = document.createElement('div');
    holder.innerHTML = offer.html;
    const card = holder.querySelector('article.car-card');
    if (!card) return null;
    const decision = findDecision(offer);
    const status = safeStatus(decision?.status);
    card.classList.toggle('user-rejected', status === 'rejected');
    card.classList.toggle('user-interesting', status === 'interesting');
    card.classList.toggle('user-review', status === 'review');
    const panel = document.createElement('div');
    panel.className = 'status-panel';
    const row = document.createElement('div');
    row.className = 'status-row';
    const label = document.createElement('label');
    label.textContent = 'Moja decyzja';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Status: ' + offer.title);
    for (const [value, name] of [['new','Bez decyzji'], ['review','Do sprawdzenia'], ['interesting','Interesująca'], ['rejected','Odrzucona']]) {
      const option = new Option(name, value); select.add(option);
    }
    select.value = status;
    select.addEventListener('change', () => { update(offer, {status:select.value}); render(); });
    row.append(label, select);
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Komentarz, powód odrzucenia, uwagi do sprzedawcy…';
    textarea.setAttribute('aria-label', 'Komentarz: ' + offer.title);
    textarea.value = decision?.comment || '';
    // Persist on change, without re-rendering during typing.
    textarea.addEventListener('input', () => update(offer, {comment:textarea.value}));
    const note = document.createElement('div');
    note.className = 'status-note';
    note.textContent = connected ? 'Zapisywane lokalnie i synchronizowane z GitHub.' : 'Zapis lokalny. Połącz GitHub, aby synchronizować z innymi urządzeniami.';
    panel.append(row, textarea, note);
    card.append(panel);
    return card;
  }
  function render() {
    const mode = $('visibility').value;
    const container = $('cards');
    container.replaceChildren();
    let visible = 0;
    for (const offer of offers) {
      const status = statusOf(offer);
      const show = mode === 'all' || (mode === 'active' && status !== 'rejected') || (mode === 'interesting' && status === 'interesting') || (mode === 'review' && (status === 'review' || status === 'new')) || (mode === 'rejected' && status === 'rejected');
      if (!show) continue;
      const card = buildCard(offer);
      if (card) { container.append(card); visible++; }
    }
    $('count').textContent = 'Wyświetlane: ' + visible + ' / ' + offers.length;
    $('empty').style.display = visible ? 'none' : 'block';
  }
  function getConfig() {
    return {owner:$('owner').value.trim(), repo:$('repo').value.trim(), branch:$('branch').value.trim() || 'main'};
  }
  function validConfig(c) { return /^[a-zA-Z0-9-]+$/.test(c.owner) && /^[a-zA-Z0-9._-]+$/.test(c.repo) && /^[a-zA-Z0-9._/-]+$/.test(c.branch); }
  function apiUrl() {
    const c = getConfig();
    if (!validConfig(c)) throw new Error('Podaj prawidłowego właściciela, repozytorium i gałąź.');
    return `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/decisions.json`;
  }
  function headers() {
    if (!token) throw new Error('Podaj token GitHub.');
    return {'Accept':'application/vnd.github+json', 'Authorization':'Bearer '+token, 'X-GitHub-Api-Version':'2022-11-28'};
  }
  function decode64(base64) {
    const bytes = Uint8Array.from(atob(base64.replace(/\s/g,'')), c=>c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  function encode64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i=0; i<bytes.length; i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
    return btoa(binary);
  }
  async function getRemote() {
    const c = getConfig();
    const res = await fetch(apiUrl() + '?ref=' + encodeURIComponent(c.branch), {headers:headers(), cache:'no-store'});
    if (res.status === 404) return {sha:null, decisions:{}};
    if (!res.ok) throw new Error('GitHub HTTP ' + res.status + ': ' + (await res.text()).slice(0,220));
    const body = await res.json();
    const doc = JSON.parse(decode64(body.content));
    if (!doc || typeof doc.decisions !== 'object' || Array.isArray(doc.decisions)) throw new Error('Nieprawidłowy format decisions.json');
    return {sha:body.sha, decisions:doc.decisions};
  }
  function merge(local, remote) {
    const result = {...remote};
    for (const [key,value] of Object.entries(local)) {
      if (!value || typeof value !== 'object') continue;
      if (!result[key] || (value.updatedAt || '') >= (result[key].updatedAt || '')) result[key] = value;
    }
    return result;
  }
  async function connect() {
    try {
      token = $('token').value.trim();
      if (!token) throw new Error('Wprowadź token GitHub.');
      localStorage.setItem(CONFIG, JSON.stringify(getConfig()));
      message('Pobieranie decyzji…');
      const remote = await getRemote();
      remoteSha = remote.sha;
      decisions = merge(decisions, remote.decisions);
      persist();
      connected = true;
      $('token').value = ''; // Token only in JS memory.
      render();
      message('Połączono. Pobrano i połączono decyzje. Zapisz, aby przesłać lokalne zmiany na GitHub.', 'ok');
    } catch (err) { connected = false; message(err.message, 'error'); }
  }
  async function syncNow() {
    if (!connected) { message('Najpierw połącz konto GitHub.', 'error'); return; }
    try {
      message('Zapisywanie decyzji na GitHub…');
      // Fetch the newest SHA to avoid overwriting another device's commit.
      const remote = await getRemote();
      decisions = merge(decisions, remote.decisions);
      const payload = JSON.stringify({version:1, decisions},null,2) + '\n';
      const c = getConfig();
      const body = {message:'Aktualizacja decyzji o ofertach',content:encode64(payload),branch:c.branch};
      if (remote.sha) body.sha = remote.sha;
      const res = await fetch(apiUrl(), {method:'PUT',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify(body)});
      if (!res.ok) throw new Error('Nie zapisano: GitHub HTTP '+res.status+': '+(await res.text()).slice(0,240));
      remoteSha = (await res.json()).content?.sha || null;
      persist(); render();
      message('Zapisano decyzje w repozytorium GitHub.', 'ok');
    } catch(err) { message(err.message + ' Lokalne zmiany pozostają w przeglądarce.', 'error'); }
  }
  function scheduleSave() {
    if (!connected) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { pending = pending.then(syncNow); }, 1200);
  }
  function exportDecisions() {
    const blob = new Blob([JSON.stringify({version:1,decisions},null,2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='decyzje-corolla.json'; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  async function importDecisions(file) {
    if (!file) return;
    try {
      const doc=JSON.parse(await file.text());
      if (!doc || !doc.decisions || typeof doc.decisions !== 'object' || Array.isArray(doc.decisions)) throw new Error('Nieprawidłowy plik JSON.');
      decisions=merge(decisions,doc.decisions); persist(); render(); scheduleSave();
      message('Zaimportowano decyzje.','ok');
    } catch(err) {message('Błąd importu: '+err.message,'error');}
  }
  async function start() {
    try {
      const saved=JSON.parse(localStorage.getItem(CONFIG)||'{}');
      $('owner').value=saved.owner||''; $('repo').value=saved.repo||''; $('branch').value=saved.branch||'main';
      const response=await fetch('offers.json',{cache:'no-store'});
      if(!response.ok) throw new Error('Nie udało się wczytać offers.json (HTTP '+response.status+').');
      const data=await response.json();
      if (!Array.isArray(data.offers)) throw new Error('Nieprawidłowy offers.json.');
      offers=data.offers; render();
    } catch(err) { message(err.message + ' Otwórz stronę przez GitHub Pages lub lokalny serwer HTTP, nie przez file://.', 'error'); }
    $('visibility').addEventListener('change',render);
    $('connect').addEventListener('click',connect);
    $('sync').addEventListener('click',()=>{ clearTimeout(saveTimer); pending=pending.then(syncNow); });
    $('export').addEventListener('click',exportDecisions);
    $('import').addEventListener('click',()=>$('importFile').click());
    $('importFile').addEventListener('change',e=>importDecisions(e.target.files[0]));
  }
  start();
})();
