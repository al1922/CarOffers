import {defaultFilters,sanitizeFilters,encodeFilters,decodeFilters,dedupe,filterOffers,sortOffers,bodyNames,statuses,fmt,dateLabel,distance,verdictNames} from './assets/core.mjs?v=15';
import {createStore} from './assets/storage.mjs?v=11';
import {loadData,loadKnowledge} from './assets/data.mjs?v=15';
import {el,button,badge,empty,link,offerCard,archivedOfferCard,offerTable,offerDetails,comparison,knowledgeCard,knowledgeDetails,updates} from './assets/views.mjs?v=16';

const $=selector=>document.querySelector(selector);
let data=null,filters=defaultFilters(),comparisonKeys=new Set(),grouped=[],archivedGrouped=[],loadToken=0;
const messages=new Set();
function notify(message){messages.add(message);const notice=$('#notice');notice.hidden=false;notice.replaceChildren(el('span','',[...messages].join(' ')),button('×',()=>{messages.clear();notice.hidden=true;},'notice-close'));notice.lastChild.setAttribute('aria-label','Zamknij komunikat');}
let browserStorage;
try{browserStorage=window.localStorage;}catch{browserStorage={getItem(){return null;},setItem(){throw Error('Storage unavailable');}};notify('Zapis lokalny jest niedostępny. Możesz korzystać ze strony i eksportować własne dane.');}
const store=createStore(browserStorage,notify);
const geoCredit=el('p','hint');geoCredit.append(link('Punkty miejscowości: GeoNames','https://www.geonames.org/',''),el('span','',' · '),link('CC BY 4.0','https://creativecommons.org/licenses/by/4.0/',''));document.querySelector('footer').append(geoCredit);
comparisonKeys=new Set(store.comparison);
for(const [id,label] of [['offer-dialog','Szczegóły oferty lub modelu'],['settings-dialog','Twoje dane i ustawienia'],['search-dialog','Zapisz wyszukiwanie']])$('#'+id).setAttribute('aria-label',label);
const keys=()=>data.models.map(m=>m.key);
const compared=o=>o.storageKeys.some(k=>comparisonKeys.has(k));
function selectedComparison(){return grouped.filter(compared).slice(0,4);}
const context=()=>({budget:data.requirements.purchase.maxPriceGrossPln,requirementsFor:o=>data.models.find(m=>m.key===o.modelKey)?.searchRequirements??data.requirements,budgetFor:o=>data.models.find(m=>m.key===o.modelKey)?.searchRequirements?.purchase?.maxPriceGrossPln??data.requirements.purchase.maxPriceGrossPln,meta:store.meta,origin:store.origin,compared,
 favorite(o){const status=store.meta(o);store.update(o,{favorite:!status.favorite});render();const target=[...document.querySelectorAll('[data-favorite-key]')].find(b=>b.dataset.favoriteKey===o.key);target?.focus();},
 compare(o,checked){if(checked){if(selectedComparison().length>=4&&!compared(o)){notify('Porównanie mieści maksymalnie cztery auta. Usuń jedno, aby dodać kolejne.');render();return;}comparisonKeys.add(o.storageKeys[0]);}else{o.storageKeys.forEach(k=>comparisonKeys.delete(k));}store.comparison=[...comparisonKeys];render();[...document.querySelectorAll('[data-compare-key]')].find(input=>input.dataset.compareKey===o.key)?.focus({preventScroll:true});},
 open:openOffer,
 save(o,patch){const success=store.update(o,patch);render();return success;}
});
function persist(push=false){store.filters=filters;const hash=encodeFilters(filters);const url=location.pathname+location.search+(hash?'#'+hash:'');if(location.pathname+location.search+location.hash!==url)history[push?'pushState':'replaceState'](null,'',url);}
function updateFilter(key,value){filters={...filters,[key]:value};persist();render();}
function navigate(section){filters={...filters,section};persist(true);render();$('#page-title').focus({preventScroll:true});}
function options(id,entries){const select=$('#'+id);select.replaceChildren();for(const [value,label] of entries){const option=el('option','',label);option.value=value;select.append(option);}}
function initOptions(){
 options('body',[['','Wszystkie'],...Object.entries(bodyNames),['unknown','Nie ustalono']]);
 const engines=new Map();for(const o of data.offers){const key=o.engineVariant||o.engine||'unknown';engines.set(key,o.engine||o.engineVariant||'Nie ustalono');}
 options('engine',[['','Wszystkie'],...[...engines].sort((a,b)=>a[1].localeCompare(b[1],'pl'))]);
 const hosts=[...new Set(data.offers.flatMap(o=>(o.urls||[]).flatMap(x=>{try{return [new URL(x.url).hostname.replace(/^www\./,'')];}catch{return [];}})))].sort();
 options('source',[['','Wszystkie'],...hosts.map(h=>[h,h])]);options('status',[['','Wszystkie'],...Object.entries(statuses)]);
 options('archive-model',[['','Wszystkie modele'],...data.models.map(m=>[m.key,m.name])]);
 options('origin-city',[['','Wybierz miasto…'],...data.cities.map(city=>[city.id,city.name]),['custom','Własny punkt — ustawienia']]);
}
function overview(){
 const matches=grouped.filter(o=>o.verdict==='match').length,located=grouped.filter(o=>o.location?.status==='available').length,geocoded=grouped.filter(o=>distance(o,{lat:0,lon:0})!==null).length;
 const rows=[[grouped.length,'Samochodów w bazie',data.offers.length+' zapisanych ogłoszeń'],[matches,'Zgodnych z warunkami','Według zapisanych dowodów'],[located,'Z miejscowością',geocoded+' z punktem do odległości'],[data.models.length,'Modeli do wyboru','Zamknięta lista wyszukiwania']];
 $('#overview').replaceChildren(...rows.map(([value,label,note])=>{const metric=el('div','metric');metric.append(el('p','metric-label',label),el('strong','',fmt(value)),el('small','',note));return metric;}));
}
function renderModels(){const focused=document.activeElement?.dataset.modelKey,search=$('#model-search').value.toLocaleLowerCase('pl'),container=$('#model-options');container.replaceChildren();for(const model of data.models){if(!model.name.toLocaleLowerCase('pl').includes(search))continue;const label=el('label'),input=el('input');input.type='checkbox';input.dataset.modelKey=model.key;input.checked=filters.models.includes(model.key);input.addEventListener('change',()=>updateFilter('models',input.checked?[...filters.models,model.key]:filters.models.filter(k=>k!==model.key)));label.append(input,el('span','',model.name),el('small','',model.loadError?'Błąd':model.count));container.append(label);if(model.key===focused)input.focus({preventScroll:true});}}
const filterNames={models:'Modele',q:'Szukaj',maxPrice:'Cena do',maxMileage:'Przebieg do',minYear:'Rok od',maxYear:'Rok do',transmission:'Skrzynia',body:'Nadwozie',engine:'Silnik',camera:'Kamera',lpg:'LPG',source:'Źródło',verdict:'Ocena',availability:'Dostępność',freshness:'Odczyt',status:'Mój status',radius:'Odległość',onlyNew:'Tylko nowe',hideDuplicates:'Bez łączenia duplikatów',includeUnknown:'Pomiń brakujące liczby'};
function activeFilters(){const container=$('#active-filters');container.replaceChildren();const defaults=defaultFilters();let count=0;for(const [key,label] of Object.entries(filterNames)){if(JSON.stringify(filters[key])===JSON.stringify(defaults[key]))continue;count++;let value=filters[key];if(key==='models')value=value.map(k=>data.models.find(m=>m.key===k)?.name||k).join(', ');else if(typeof value==='boolean')value='';else if($('#'+key)?.tagName==='SELECT')value=$('#'+key).selectedOptions[0]?.textContent||value;const text=label+(value?': '+value:'');const b=button(text+' ×',()=>updateFilter(key,defaults[key]),'chip-button');b.setAttribute('aria-label','Usuń filtr: '+text);container.append(b);}$('#filter-count').textContent=count?'('+count+')':'';
 const searches=$('#saved-searches');searches.replaceChildren();if(store.searches.length)searches.append(el('span','','Zapisane:'));store.searches.forEach((search,i)=>{const row=el('span');row.append(button(search.name,()=>{filters=decodeFilters(search.query,keys());persist();render();},'chip-button'),button('×',()=>{store.deleteSearch(i);activeFilters();},'chip-button'));row.lastChild.setAttribute('aria-label','Usuń zapisane wyszukiwanie: '+search.name);searches.append(row);});}
function renderTray(){const list=selectedComparison(),tray=$('#compare-tray');tray.hidden=!list.length||filters.section==='compare';tray.replaceChildren(el('span','',`${list.length} / 4 auta do porównania`),button('Porównaj →',()=>navigate('compare'),'button primary'),button('×',()=>{comparisonKeys.clear();store.comparison=[];render();},''));tray.lastChild.setAttribute('aria-label','Wyczyść porównanie');}
function renderArchive(){
 const query=$('#archive-search').value.trim().toLocaleLowerCase('pl'),model=$('#archive-model').value,status=$('#archive-status').value;
 const list=archivedGrouped.filter(o=>{
  if(model&&o.modelKey!==model)return false;
  if(status&&o.archive?.status!==status)return false;
  if(!query)return true;
  return [o.title,o.modelName,o.vin,o.seller,o.engine,o.location?.city,o.location?.voivodeship,o.archive?.reason,o.archive?.reportNote].filter(Boolean).join(' ').toLocaleLowerCase('pl').includes(query);
 }).sort((a,b)=>(Date.parse(b.archive?.archivedAt)||0)-(Date.parse(a.archive?.archivedAt)||0));
 $('#archive-count').textContent=`${list.length} z ${archivedGrouped.length} ofert archiwalnych`;
 const results=$('#archive-results');results.replaceChildren();
 if(!list.length)results.append(empty('Brak ofert w archiwum','Zmień wyszukiwanie lub wybierz inny status.'));
 else results.append(...list.map(o=>archivedOfferCard(o,context())));
}
function render(){
 if(!data)return;
 grouped=dedupe(data.offers);
 archivedGrouped=dedupe(data.archivedOffers||[]);
 $('#nav-total').textContent=grouped.length;$('#nav-archive').textContent=archivedGrouped.length;$('#nav-saved').textContent=grouped.filter(o=>store.meta(o).favorite).length;$('#nav-compare').textContent=selectedComparison().length;
 document.querySelectorAll('[data-section]').forEach(b=>{const active=b.dataset.section===filters.section;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
 const titles={offers:'Oferty samochodów',archive:'Archiwum',saved:'Zapisane',compare:'Porównanie',knowledge:'Modele i wiedza',updates:'Źródła'};
 $('#page-title').textContent=titles[filters.section];$('#page-title').tabIndex=-1;document.title=titles[filters.section]+' — CarOffers';
 const browsing=['offers','saved'].includes(filters.section);
 $('#browser-tools').hidden=!browsing;$('#offers-section').hidden=!browsing;
 for(const section of ['archive','compare','knowledge','updates'])$('#'+section+'-section').hidden=filters.section!==section;
 $('#overview').hidden=filters.section==='archive';
 overview();
 for(const input of document.querySelectorAll('[data-filter]')){const value=filters[input.dataset.filter];if(input.type==='checkbox')input.checked=value;else input.value=value;}
 if(document.activeElement!==$('#search'))$('#search').value=filters.q;
 $('#radius').disabled=!store.origin;
 $('#origin-bar').hidden=!browsing&&filters.section!=='compare';
 $('#origin-city').value=store.origin?(store.origin.cityId||'custom'):'';
 const withPoints=data.offers.filter(o=>distance(o,store.origin)!==null).length;
 $('#distance-summary').textContent=store.origin?`Punkt: ${store.origin.name||'własne współrzędne'} · odległości dla ${withPoints} ofert. Linia prosta, do punktu miejscowości — nie trasa do sprzedawcy.`:'Wybierz miasto. Odległości liczymy lokalnie; Twój punkt nie jest wysyłany do serwisów mapowych.';
 renderModels();activeFilters();renderTray();
 $('#viewCards').setAttribute('aria-pressed',String(filters.view==='cards'));$('#viewTable').setAttribute('aria-pressed',String(filters.view==='table'));
 if(browsing){
  const base=filters.hideDuplicates?grouped:data.offers.map(o=>{const conflict=grouped.find(g=>g.identityConflict&&g.key===o.key);return conflict||o;});
  const scoped=filters.section==='saved'?base.filter(o=>store.meta(o).favorite):base;
  const list=sortOffers(filterOffers(scoped,filters,{meta:store.meta,origin:store.origin}),filters.sort,store.origin);
  $('#result-title').textContent=filters.section==='saved'?'Twoja krótka lista':'Oferty do przejrzenia';
  $('#result-count').textContent=`${list.length} z ${scoped.length} ${filters.hideDuplicates?'samochodów':'ogłoszeń'}${data.warnings.length?' · część plików niedostępna':''}`;
  const hint=$('#sort-hint');hint.hidden=!['newest','checked','distance'].includes(filters.sort);hint.textContent=filters.sort==='newest'?'Sortowanie według daty pierwszego znalezienia. Oferty bez daty są na końcu.':filters.sort==='checked'?'Sortowanie według ostatniego udanego odczytu. Brak daty nie oznacza świeżej oferty.':store.origin?'Dostępne odległości pokazano przy lokalizacji auta. Brak danych pomijamy.':'Ustaw punkt startowy w „Kopia danych i ustawienia”. Bez niego odległość jest nieznana.';
  const results=$('#results');results.className=filters.view==='cards'?'offer-grid':'';results.replaceChildren();
  if(!list.length){const message=filters.section==='saved'?'Zapisz auta przyciskiem serca. Jeżeli masz zapisane auta, sprawdź aktywne filtry.':'Zmień filtry. Pusta lista nie dowodzi braku ofert na rynku — pokrycie portali sprawdzisz w Aktualizacjach.';results.append(empty('Nie ma tu jeszcze wyników',message));}
  else if(filters.view==='table')results.append(offerTable(list,context()));else results.append(...list.map(o=>offerCard(o,context())));
 }
 if(filters.section==='compare')$('#compare-section').replaceChildren(comparison(selectedComparison(),context()));
 if(filters.section==='archive')renderArchive();
 if(filters.section==='knowledge'){const container=$('#knowledge-section'),grid=el('div','knowledge-grid');grid.append(...data.catalog.models.filter(m=>m.active).map(m=>knowledgeCard(m,data.models.find(e=>e.key===m.key),openKnowledge)));container.replaceChildren(el('p','section-intro','Karty są częściowe. Luki w źródłach i warianty wstrzymane pozostają widoczne. Sama obecność silnika w katalogu nie oznacza rekomendacji trwałości.'),grid);}
 if(filters.section==='updates')$('#updates-section').replaceChildren(updates(data));
}
function openOffer(o){knowledgeToken++;$('#offer-detail').replaceChildren(offerDetails(o,context()));$('#offer-dialog').showModal();$('#offer-dialog').scrollTop=0;}
let knowledgeToken=0;
async function openKnowledge(model){const token=++knowledgeToken;$('#offer-detail').replaceChildren(el('p','','Wczytywanie karty wiedzy…'));$('#offer-dialog').showModal();try{const card=await loadKnowledge(model);if(token!==knowledgeToken)return;$('#offer-detail').replaceChildren(knowledgeDetails(model,card));}catch{$('#offer-detail').replaceChildren(empty('Nie udało się wczytać karty','Spróbuj ponownie. Brak dostępu nie oznacza braku wiedzy.'));}}
function showSettings(){const origin=store.origin;$('#origin-lat').value=origin?.lat??'';$('#origin-lon').value=origin?.lon??'';$('#origin-state').textContent=origin?`Zapisany punkt: ${origin.lat}, ${origin.lon}. Odległość tylko dla aut z udokumentowanymi współrzędnymi.`:'Nie zapisano punktu startowego.';$('#settings-dialog').showModal();}
async function boot(reload=false){const token=++loadToken;$('#reload-data').disabled=true;try{const loaded=await loadData();if(token!==loadToken)return;data=loaded;if(!store.origin){const defaultCity=data.cities.find(city=>city.name==='Zielona Góra');if(defaultCity)store.origin={lat:defaultCity.lat,lon:defaultCity.lon,name:defaultCity.name,cityId:defaultCity.id,sourceUrl:defaultCity.sourceUrl};}store.markNew(data.offers);if(!reload)filters=location.hash&&location.hash!=='#main'?decodeFilters(location.hash,keys()):sanitizeFilters(store.filters||{},keys());else filters=sanitizeFilters(filters,keys());initOptions();for(const warning of data.warnings)notify(warning);if(!data.reportValid)notify('Raport oceny jest niedostępny lub nie odpowiada bieżącej konfiguracji. Oferty wymagają ponownej oceny.');persist();render();if(reload)notify('Wczytano aktualnie zapisane pliki. Nie sprawdzano ogłoszeń na portalach.');}catch(error){notify('Nie udało się wczytać danych: '+error.message);$('#result-count').textContent='Dane niedostępne';$('#results').replaceChildren(empty('Nie udało się otworzyć bazy','Sprawdź połączenie i użyj „Wczytaj dane ponownie”.'));}finally{$('#reload-data').disabled=false;}}

document.querySelectorAll('[data-section]').forEach(b=>b.addEventListener('click',()=>data&&navigate(b.dataset.section)));
document.querySelectorAll('[data-filter]').forEach(input=>input.addEventListener(input.tagName==='SELECT'||input.type==='checkbox'?'change':'input',()=>{if(!data)return;updateFilter(input.dataset.filter,input.type==='checkbox'?input.checked:input.value);}));
$('#search').addEventListener('input',event=>{if(data)updateFilter('q',event.target.value);});
$('#archive-search').addEventListener('input',()=>data&&renderArchive());$('#archive-model').addEventListener('change',()=>data&&renderArchive());$('#archive-status').addEventListener('change',()=>data&&renderArchive());
$('#model-search').addEventListener('input',()=>data&&renderModels());$('#clear-models').addEventListener('click',()=>data&&updateFilter('models',[]));
$('#filter-toggle').addEventListener('click',()=>{const panel=$('#filters');panel.hidden=!panel.hidden;$('#filter-toggle').setAttribute('aria-expanded',String(!panel.hidden));});
$('#reset-filters').addEventListener('click',()=>{if(!data)return;filters={...defaultFilters(),section:filters.section,view:filters.view};persist();render();});
$('#viewCards').addEventListener('click',()=>data&&updateFilter('view','cards'));$('#viewTable').addEventListener('click',()=>data&&updateFilter('view','table'));
$('#close-offer').addEventListener('click',()=>{$('#offer-dialog').close();knowledgeToken++;});$('#close-settings').addEventListener('click',()=>$('#settings-dialog').close());$('#close-search').addEventListener('click',()=>$('#search-dialog').close());
$('#offer-dialog').addEventListener('click',event=>{const dialog=event.currentTarget,rect=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom))dialog.close();});
$('#settings-dialog').addEventListener('close',()=>{if(data)render();});
$('#offer-dialog').addEventListener('close',()=>knowledgeToken++);
$('#backup-open').addEventListener('click',showSettings);$('#mobile-settings').addEventListener('click',showSettings);
$('#quick-settings').addEventListener('click',showSettings);
$('#origin-custom').addEventListener('click',showSettings);
$('#origin-city').addEventListener('change',event=>{if(event.target.value==='custom'){showSettings();return;}const city=data.cities.find(city=>city.id===event.target.value);store.origin=city?{lat:city.lat,lon:city.lon,name:city.name,cityId:city.id,sourceUrl:city.sourceUrl}:null;if(!city)filters.radius='';persist();render();});
function syncThemeControls(){const dark=document.documentElement.dataset.theme==='dark',label=dark?'Włącz tryb jasny':'Włącz tryb ciemny';for(const id of ['themeToggle','mobile-theme'])$('#'+id).textContent=label;$('#quick-theme').setAttribute('aria-label',label);$('#quick-theme').setAttribute('aria-pressed',String(dark));}
function theme(){const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{browserStorage.setItem('carOffersTheme',next);}catch{notify('Nie udało się zapamiętać motywu.');}syncThemeControls();}
try{document.documentElement.dataset.theme=browserStorage.getItem('carOffersTheme')==='dark'?'dark':'light';}catch{}syncThemeControls();
$('#themeToggle').addEventListener('click',theme);$('#mobile-theme').addEventListener('click',theme);
$('#quick-theme').addEventListener('click',theme);
$('#reload-data').addEventListener('click',()=>boot(true));
$('#export-data').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([store.export()],{type:'application/json'})),a=el('a');a.href=url;a.download='caroffers-moje-dane-'+new Date().toISOString().slice(0,10)+'.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('#import-data').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>5e6)throw Error('Plik może mieć maksymalnie 5 MB.');const saved=store.import(JSON.parse(await file.text()));comparisonKeys=new Set(store.comparison);filters=sanitizeFilters(store.filters||filters,keys());persist();render();notify(saved?'Scalono kopię i przywrócono zapisane ustawienia widoku. Dane ofert pozostały bez zmian.':'Kopia została odczytana do pamięci, lecz zapis w przeglądarce jest niedostępny. Wykonaj eksport przed zamknięciem strony.');$('#settings-dialog').close();}catch(error){notify('Nie wczytano kopii: '+error.message);}event.target.value='';});
$('#origin-form').addEventListener('submit',event=>{event.preventDefault();const lat=Number($('#origin-lat').value),lon=Number($('#origin-lon').value);if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return;store.origin={lat,lon,name:'Własny punkt'};$('#origin-state').textContent='Zapisano punkt. Zapisano punkt startowy.';render();});
$('#clear-origin').addEventListener('click',()=>{store.origin=null;filters.radius='';persist();$('#origin-lat').value='';$('#origin-lon').value='';$('#origin-state').textContent='Nie zapisano punktu startowego.';render();});
$('#save-search').addEventListener('click',()=>{if(data)$('#search-dialog').showModal();});$('#save-search-form').addEventListener('submit',event=>{event.preventDefault();const name=$('#search-name').value.trim();if(!name)return;store.saveSearch(name,encodeFilters({...filters,section:'offers'}));$('#search-dialog').close();render();});
function restoreURL(){if(data&&location.hash!=='#main'){filters=decodeFilters(location.hash,keys());store.filters=filters;render();}}
window.addEventListener('hashchange',restoreURL);window.addEventListener('popstate',restoreURL);
boot();
