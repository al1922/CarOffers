'use strict';
// Statyczna aplikacja: modele z models.json, oferty z offers/*.json, bez GitHub API.
const $ = s => document.querySelector(s);
const tabs = $('#modelTabs'), panel = $('#cards'), count = $('#count'), empty = $('#empty');
const requirements = $('#modelRequirements'), corollaRequirements = requirements.innerHTML;
const controls = ['search','maxPrice','maxMileage','minYear','engineFilter','bodyFilter','transmissionFilter','verdictFilter','sort','onlyNew','hideDuplicates'];
const cache = new Map();
let models = [], selectedModel = '', offers = [], latestToken = 0, view = 'cards';
const fmt = n => Number.isFinite(n) ? new Intl.NumberFormat('pl-PL').format(n) : '—';
const safe = v => String(v ?? '').trim();
const verdictName = v => ({match:'Zgodne',check:'Do weryfikacji',review:'Do weryfikacji',fail:'Poza wymaganiami'})[v] || 'Do sprawdzenia';
const verdictRank = v => ({match:0,check:1,review:1,fail:2})[v] ?? 1;
const validModel = m => m && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.key||'') && typeof m.name === 'string' && /^offers\/[a-z0-9-]+\.json$/.test(m.file||'');
function node(tag, cls, value) { const el=document.createElement(tag); if(cls) el.className=cls; if(value!==undefined) el.textContent=safe(value); return el; }
function button(text, click){const b=node('button','',text);b.type='button';b.addEventListener('click',click);return b;}
function offerLinks(offer){
 const wrap=node('div','offer-actions');
 for(const link of (Array.isArray(offer.urls)?offer.urls:[])){
  if(!/^https:\/\//i.test(link.url||'')) continue;
  const a=node('a','link-button',link.label||'Ogłoszenie');a.href=link.url;a.target='_blank';a.rel='noopener noreferrer';wrap.append(a);
 }
 return wrap;
}
function details(offer){
 const d=node('div','offer-details');
 if(offer.verdictNote){d.append(node('h4','','Ocena zgodności'),node('p','',offer.verdictNote));}
 for(const [key,val] of Object.entries(offer.details||{})){
  if(!val)continue;d.append(node('h4','',key),node('p','',val));
 }
 if(offer.vin)d.append(node('h4','','VIN'),node('p','',offer.vin));
 d.append(offerLinks(offer));return d;
}
function card(offer){
 const c=node('article','car-card');
 const top=node('div','offer-summary'), left=node('div'), right=node('div','offer-price',offer.priceLabel||(Number.isFinite(offer.price)?fmt(offer.price)+' zł':'Brak ceny'));
 left.append(node('div','offer-meta',offer.subtitle||''),node('h3','',offer.title||'Oferta samochodu'));
 const badges=node('div');badges.append(node('span','verdict-chip '+(offer.verdict||''),verdictName(offer.verdict)));
 if(offer.isNew)badges.append(node('span','new-chip','Nowa'));
 left.append(badges);top.append(left,right);c.append(top);
 const meta=node('div','offer-tags');
 for(const val of [offer.year&&offer.year+' r.',offer.mileage!=null&&fmt(offer.mileage)+' km',offer.engine,offer.body,offer.transmission])if(val)meta.append(node('span','',val));
 c.append(meta);
 if(offer.seller)c.append(node('p','offer-meta',offer.seller));
 const actions=node('div','offer-actions');let opened=false;const toggle=button('Szczegóły',()=>{opened=!opened; extra.hidden=!opened;toggle.textContent=opened?'Zwiń szczegóły':'Szczegóły';toggle.setAttribute('aria-expanded',String(opened));});toggle.setAttribute('aria-expanded','false');
 actions.append(toggle);const first=(offer.urls||[]).find(x=>/^https:\/\//i.test(x.url||''));if(first){const a=node('a','link-button','Otwórz ogłoszenie');a.href=first.url;a.target='_blank';a.rel='noopener noreferrer';actions.append(a);}
 c.append(actions);const extra=details(offer);extra.hidden=true;c.append(extra);return c;
}
function table(offers){
 const wrap=node('div','offer-table-wrap'), t=node('table','offer-table'), head=node('thead'), hr=node('tr');
 for(const title of ['Samochód','Rok','Silnik','Przebieg','Cena','Ocena','Ogłoszenie'])hr.append(node('th','',title));head.append(hr);t.append(head);
 const body=node('tbody');
 for(const o of offers){
  const tr=node('tr');const name=node('td');name.append(node('strong','',o.title||'Oferta'));if(o.isNew)name.append(node('span','new-chip','Nowa'));tr.append(name);
  for(const v of [o.year||'—',o.engine||'—',o.mileage!=null?fmt(o.mileage)+' km':'—'])tr.append(node('td','',v));
  tr.append(node('td','offer-price',o.priceLabel||(fmt(o.price)+' zł')));
  const verdict=node('td');verdict.append(node('span','verdict-chip '+(o.verdict||''),verdictName(o.verdict)));tr.append(verdict);
  const act=node('td'), detailRow=node('tr','detail-row'), detailCell=node('td');detailCell.colSpan=7;detailCell.append(details(o));detailRow.append(detailCell);detailRow.hidden=true;
  const toggle=button('Szczegóły',()=>{detailRow.hidden=!detailRow.hidden;toggle.textContent=detailRow.hidden?'Szczegóły':'Zwiń';});act.append(toggle);tr.append(act);body.append(tr,detailRow);
 }
 t.append(body);wrap.append(t);return wrap;
}
function identityKeys(o){
 const keys=[];if(o.vin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(o.vin))keys.push('vin:'+o.vin.toUpperCase());
 for(const id of o.listingIds||[])if(id)keys.push('listing:'+String(id).toLowerCase());
 for(const item of o.urls||[]){const url=item.normalized||item.url;if(url){try{const u=new URL(url);keys.push('url:'+u.hostname.replace(/^www\./,'').toLowerCase()+u.pathname.replace(/\/$/,''));}catch{}}}
 if(o.id)keys.push('id:'+o.id.toLowerCase());return [...new Set(keys)];
}
// Łączy oferty współdzielące VIN, ID ogłoszenia lub adres URL; nie zgaduje po samym tytule.
function dedupe(list){
 const parents=list.map((_,i)=>i);const find=i=>parents[i]===i?i:(parents[i]=find(parents[i]));
 const seen=new Map();list.forEach((o,i)=>{for(const k of identityKeys(o)){if(seen.has(k))parents[find(i)]=find(seen.get(k));else seen.set(k,i);}});
 const groups=new Map();list.forEach((o,i)=>{const root=find(i);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(o);});
 return [...groups.values()].map(group=>{
  const winner=group.find(x=>x.vin)||group[0];
  return {...winner,urls:[...new Map(group.flatMap(x=>x.urls||[]).map(x=>[x.normalized||x.url,x])).values()],isNew:group.some(x=>x.isNew),duplicateCount:group.length};
 });
}
function valuesFor(key){return [...new Set(offers.map(o=>safe(o[key])).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pl'));}
function updateSelect(id,vals){const el=$('#'+id);el.replaceChildren(new Option('Wszystkie',''));for(const v of vals)el.add(new Option(v,v));}
function render(){
 const text=$('#search').value.trim().toLocaleLowerCase('pl');const price=Number($('#maxPrice').value)||Infinity, mileage=Number($('#maxMileage').value)||Infinity, year=Number($('#minYear').value)||0;
 let list=offers.filter(o=>{
  if(o.price!=null && o.price>price || o.mileage!=null && o.mileage>mileage || o.year!=null && o.year<year)return false;
  if($('#engineFilter').value && o.engine!==$('#engineFilter').value)return false;
  if($('#bodyFilter').value && o.body!==$('#bodyFilter').value)return false;
  if($('#transmissionFilter').value && o.transmission!==$('#transmissionFilter').value)return false;
  if($('#verdictFilter').value && (o.verdict==='review'?'check':o.verdict)!==$('#verdictFilter').value)return false;
  if($('#onlyNew').checked && !o.isNew)return false;
  return !text || [o.title,o.seller,o.vin,o.engine,o.body,o.transmission,...Object.values(o.details||{})].join(' ').toLocaleLowerCase('pl').includes(text);
 });
 if($('#hideDuplicates').checked)list=dedupe(list);
 const sort=$('#sort').value;
 list.sort((a,b)=>{
  const n=(v,def)=>Number.isFinite(v)?v:def;
  if(sort==='priceAsc')return n(a.price,Infinity)-n(b.price,Infinity);
  if(sort==='priceDesc')return n(b.price,-1)-n(a.price,-1);
  if(sort==='yearDesc')return n(b.year,0)-n(a.year,0);
  if(sort==='mileageAsc')return n(a.mileage,Infinity)-n(b.mileage,Infinity);
  if(sort==='newest')return Number(b.isNew)-Number(a.isNew);
  return verdictRank(a.verdict)-verdictRank(b.verdict)||n(a.price,Infinity)-n(b.price,Infinity);
 });
 panel.replaceChildren();panel.className=view==='cards'?'offer-list':'';
 if(view==='cards'){const frag=document.createDocumentFragment();for(const o of list)frag.append(card(o));panel.append(frag);}else panel.append(table(list));
 count.textContent=`${list.length} z ${offers.length} ofert`;
 empty.hidden=list.length!==0;empty.textContent='Brak ofert spełniających wybrane filtry.';
}
function renderTabs(){tabs.replaceChildren();for(const m of models){const b=button(m.name,()=>{location.hash=encodeURIComponent(m.key);selectModel(m.key);});b.className='model-tab';b.setAttribute('role','tab');b.setAttribute('aria-selected',String(m.key===selectedModel));tabs.append(b);}}
async function loadOffers(m){const response=await fetch('./'+m.file,{cache:'no-store'});if(!response.ok)throw Error('Nie udało się pobrać ofert: '+m.file+' (HTTP '+response.status+')');const data=await response.json();if(!Array.isArray(data.offers))throw Error('Brak tablicy offers w '+m.file);return data.offers;}
function markNew(list,key){
 // Snapshot zapisujemy dopiero po odczytaniu poprzedniego; zmiana ID nowej oferty może spowodować ponowne oznaczenie.
 const storageKey='car-offer-seen-v2:'+key;
 try{const previous=JSON.parse(localStorage.getItem(storageKey)||'null');const prior=new Set(Array.isArray(previous)?previous:[]);
  for(const o of list)o.isNew=Array.isArray(previous)&&!identityKeys(o).some(k=>prior.has(k));
  const all=[...new Set(list.flatMap(identityKeys))];localStorage.setItem(storageKey,JSON.stringify([...new Set([...prior,...all])]));
 }catch{for(const o of list)o.isNew=false;}
}
async function selectModel(key){const m=models.find(x=>x.key===key);if(!m)return;const token=++latestToken;selectedModel=key;renderTabs();$('#modelTitle').textContent=m.name;document.title=m.name+' — oferty samochodów';requirements.innerHTML=m.requirements==='corolla'?corollaRequirements:'';panel.replaceChildren();count.textContent='Ładowanie…';empty.hidden=true;
 try{const list=await loadOffers(m);if(token!==latestToken)return;offers=list;markNew(offers,key);for(const [id,field] of [['engineFilter','engine'],['bodyFilter','body'],['transmissionFilter','transmission']])updateSelect(id,valuesFor(field));
  for(const id of ['search','maxPrice','maxMileage','minYear','verdictFilter'])$('#'+id).value='';$('#onlyNew').checked=false;render();
 }catch(e){if(token!==latestToken)return;count.textContent='';empty.hidden=false;empty.textContent=e.message;console.error(e);}
}
for(const id of controls)$('#'+id).addEventListener(['onlyNew','hideDuplicates','engineFilter','bodyFilter','transmissionFilter','verdictFilter','sort'].includes(id)?'change':'input',render);
$('#resetFilters').addEventListener('click',()=>{for(const id of ['search','maxPrice','maxMileage','minYear','engineFilter','bodyFilter','transmissionFilter','verdictFilter'])$('#'+id).value='';$('#sort').value='priority';$('#onlyNew').checked=false;$('#hideDuplicates').checked=true;render();});
function setView(v){view=v;$('#viewCards').classList.toggle('active',v==='cards');$('#viewTable').classList.toggle('active',v==='table');$('#viewCards').setAttribute('aria-pressed',String(v==='cards'));$('#viewTable').setAttribute('aria-pressed',String(v==='table'));render();}
$('#viewCards').addEventListener('click',()=>setView('cards'));$('#viewTable').addEventListener('click',()=>setView('table'));
window.addEventListener('hashchange',()=>{const key=decodeURIComponent(location.hash.slice(1));if(key!==selectedModel && models.some(m=>m.key===key))selectModel(key);});
(async()=>{try{const response=await fetch('./models.json',{cache:'no-store'});if(!response.ok)throw Error('Nie udało się pobrać models.json');const data=await response.json();models=(data.models||[]).filter(validModel);if(!models.length)throw Error('Brak poprawnie zdefiniowanych modeli.');const key=decodeURIComponent(location.hash.slice(1));await selectModel(models.some(m=>m.key===key)?key:models[0].key);}catch(e){empty.hidden=false;empty.textContent=e.message;console.error(e);}})();
