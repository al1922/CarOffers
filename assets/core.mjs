// Pure domain and browsing functions. No DOM, storage or network access.
export const verdictNames = {match:'Zgodne z warunkami',check:'Do weryfikacji',fail:'Poza wymaganiami'};
export const statuses = {considering:'Do rozważenia',contact:'Kontakt ze sprzedawcą',inspection:'Oględziny',rejected:'Odrzucone przeze mnie',bought:'Kupione'};
export const bodyNames = {wagon:'Kombi',sedan:'Sedan',suv:'SUV',crossover:'Crossover',hatchback:'Hatchback',minivan:'Minivan'};
export const reasons = {
 purchase_price:'Brak ceny zakupu',price_over_limit:'Cena ponad budżetem',price_exception_requires_user_confirmation:'Cena ponad budżetem — potrzebna Twoja decyzja',
 gross_price_and_purchase_conditions:'Potwierdzić pełną cenę brutto i brak obowiązkowego finansowania',production_year:'Potwierdzić rok produkcji',year_outside_selection:'Rocznik poza zakresem',
 body:'Potwierdzić nadwozie',body_outside_selection:'Nadwozie poza zakresem',exact_engine_variant:'Potwierdzić dokładny wariant silnika',engine_outside_selection:'Silnik poza listą',engine_review_requires_verification:'Wariant silnika wymaga dodatkowej weryfikacji',
 transmission:'Potwierdzić skrzynię',transmission_outside_selection:'Skrzynia poza zakresem',camera_unavailable:'Brak możliwości instalacji kamery',camera_retrofit_not_allowed:'Montaż kamery poza wymaganiami',camera_or_compatible_retrofit:'Potwierdzić kamerę lub zgodność montażu',
 structural_damage:'Potwierdzone szkody konstrukcyjne',structural_history:'Brak niezależnej kontroli historii konstrukcyjnej',mileage:'Brak przebiegu',mileage_over_hard_limit:'Przebieg ponad limitem',mileage_above_preference:'Przebieg powyżej preferencji',stroller_and_family_fit:'Potwierdzić miejsce na wózek i bagaże',auction_not_allowed:'Aukcja jest wykluczona',purchase_not_auction:'Potwierdzić sprzedaż poza aukcją'
};
export const reason = value => reasons[value] || (value.startsWith('variant_configuration_conflict:')?'Konflikt wariantu z okresem produkcji lub nadwoziem':value);
export const fmt = value => Number.isFinite(value)?new Intl.NumberFormat('pl-PL').format(value):'—';
export const money = value => Number.isFinite(value)?fmt(value)+' zł':'Brak ceny';
export function dateLabel(value){
 if(!value)return 'Brak daty';
 const day=/^\d{4}-\d{2}-\d{2}$/.test(value);
 const date=new Date(day?value+'T12:00:00Z':value);
 if(!Number.isFinite(+date))return 'Nieprawidłowa data';
 return new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',day:'numeric',month:'short',year:'numeric',...(!day?{hour:'2-digit',minute:'2-digit'}:{})}).format(date);
}
export function safeURL(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
export function canonicalURL(value){const valid=safeURL(value);if(!valid)return null;const u=new URL(valid);return u.hostname.replace(/^www\./,'').toLowerCase()+(u.port?':'+u.port:'')+u.pathname.replace(/\/$/,'')+u.search;}
export function identityKeys(o){return [...new Set([
 ...(o.id?['id:'+o.id.toLowerCase()]:[]),...(/^[A-HJ-NPR-Z0-9]{17}$/i.test(o.vin||'')?['vin:'+o.vin.toUpperCase()]:[]),
 ...(o.listingIds||[]).map(x=>'listing:'+x.toLowerCase()),...(o.urls||[]).flatMap(x=>[x.url,x.normalized].map(canonicalURL).filter(Boolean).map(u=>'url:'+u))
 ])];}
export function normalize(o,model){
 const transmission=o.transmissionCode || (/automat|dsg|dct|cvt|edc/i.test(o.transmission||'')?'automatic':/manual/i.test(o.transmission||'')?'manual':'unknown');
 const body=o.bodyCode || (/kombi|wagon|variant|grandtour|sportswagon|touring sports/i.test(o.body||'')?'wagon':/sedan/i.test(o.body||'')?'sedan':/crossover/i.test(o.body||'')?'crossover':/suv/i.test(o.body||'')?'suv':/minivan|mpv/i.test(o.body||'')?'minivan':/hatchback/i.test(o.body||'')?'hatchback':'unknown');
 return {...o,modelKey:model.key,modelName:model.name,displayTransmission:transmission,displayBody:body,
  // These display codes never become evidence or feed the assessment engine.
  storageKeys:identityKeys(o),key:model.key+'|'+o.id};
}
export function dedupe(list){
 const parent=list.map((_,i)=>i),find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
 const seen=new Map();
 list.forEach((o,i)=>identityKeys(o).forEach(k=>{if(seen.has(k))parent[find(i)]=find(seen.get(k));else seen.set(k,i);}));
 const groups=new Map();list.forEach((o,i)=>{const k=find(i);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(o);});
 return [...groups.values()].flatMap(group=>{
  const vins=new Set(group.map(o=>o.vin?.toUpperCase()).filter(Boolean));
  const models=new Set(group.map(o=>o.modelKey));
  const contradictory=['year','engineVariant','bodyCode'].some(field=>new Set(group.map(o=>o[field]).filter(value=>value!==null&&value!==undefined)).size>1);
  if(vins.size>1||models.size>1||contradictory)return group.map(o=>({...o,identityConflict:true,storageKeys:['conflict:'+o.key+'|'+[o.vin,o.year,o.engineVariant,o.bodyCode].map(v=>v??'').join('|')],members:[o]}));
  const sorted=[...group].sort((a,b)=>(Date.parse(b.lastCheckedAt)||0)-(Date.parse(a.lastCheckedAt)||0));
  const winner=sorted[0];
  return [{...winner,members:group,storageKeys:[...new Set(group.flatMap(o=>o.storageKeys))],
   urls:[...new Map(group.flatMap(o=>o.urls||[]).map(x=>[canonicalURL(x.url),x])).values()],
   listingStates:[...new Map(group.flatMap(o=>o.listingStates||[]).map(x=>[canonicalURL(x.url),x])).values()],
   history:[...new Map(group.flatMap(o=>o.history||[]).map(x=>[x.eventId||JSON.stringify(x),x])).values()],
   isNew:group.some(o=>o.isNew)}];
 });
}
export function locationLabel(o){return o.location?.status==='available'&&o.location.city?o.location.city:'';}
export const cameraLabel = o => ({installed_confirmed:'Kamera potwierdzona',retrofit_confirmed:'Montaż kamery potwierdzony'})[o.cameraStatus]||'';
export const lpgLabel = o => o.lpgInstalled===true?'LPG: instalacja obecna':'';
export function attachLocation(offer,entry){
 if(offer.location?.status==='available'||!entry||entry.evidence?.historicalTitle!==offer.title)return offer;
 const source=canonicalURL(entry.evidence.sourceUrl);
 if(!source||!(offer.urls||[]).some(link=>canonicalURL(link.url)===source))return offer;
 return {...offer,location:entry.location,locationEvidence:entry.evidence};
}
export function availability(o){
 const list=o.listingStates||[];
 if(!list.length)return 'unknown';
 // The last failed attempt must not be presented as a fresh availability check.
 if(list.some(s=>s.status==='available'&&s.lastObservation?.availability!=='access_error'))return 'available';
 if(list.some(s=>s.lastObservation?.availability==='access_error'))return 'access_error';
 if(list.some(s=>s.status==='available'))return 'available';
 if(list.every(s=>['sold','removed'].includes(s.status)))return 'closed';
 return 'unknown';
}
export const availabilityNames={unknown:'Aktualność nieustalona',access_error:'Błąd ostatniego odczytu',available:'Dostępne przy ostatnim odczycie',closed:'Zakończone ogłoszenia'};
export function freshness(o,now=Date.now()){
 if(!o.lastCheckedAt)return 'unknown';
 const parsed=Date.parse(o.lastCheckedAt);if(!Number.isFinite(parsed)||parsed>now)return 'unknown';
 return now-parsed<=7*86400000?'recent':'old';
}
export function distance(o,origin){
 if(!origin||o.location?.status!=='available'||!safeURL(o.location.geoSource))return null;
 const {latitude:lat,longitude:lon}=o.location;
 if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return null;
 const rad=x=>x*Math.PI/180,a=rad(lat-origin.lat),b=rad(lon-origin.lon);
 const h=Math.sin(a/2)**2+Math.cos(rad(origin.lat))*Math.cos(rad(lat))*Math.sin(b/2)**2;
 return 6371*2*Math.asin(Math.sqrt(Math.min(1,h)));
}
export const defaultFilters=()=>({models:[],q:'',maxPrice:'',maxMileage:'',minYear:'',maxYear:'',transmission:'',body:'',engine:'',camera:'',lpg:'',source:'',verdict:'',availability:'',freshness:'',status:'',radius:'',onlyNew:false,hideDuplicates:true,includeUnknown:true,sort:'priority',view:'cards',section:'offers'});
const filterKeys=Object.keys(defaultFilters());
export function sanitizeFilters(input={},validModels=[]){
 const output=defaultFilters();
 for(const key of filterKeys){if(key==='models')continue;if(typeof input[key]===typeof output[key])output[key]=input[key];}
 output.models=Array.isArray(input.models)?[...new Set(input.models.filter(k=>validModels.includes(k)))]:[];
 for(const key of ['maxPrice','maxMileage','minYear','maxYear','radius'])if(output[key]!==''&&(!Number.isFinite(+output[key])||+output[key]<0))output[key]='';
 if(!['offers','saved','compare','knowledge','updates'].includes(output.section))output.section='offers';
 if(!['cards','table'].includes(output.view))output.view='cards';
 if(!['priority','priceAsc','priceDesc','mileageAsc','yearDesc','newest','checked','distance'].includes(output.sort))output.sort='priority';
 return output;
}
export function encodeFilters(filters){const params=new URLSearchParams();const defaults=defaultFilters();for(const k of filterKeys){const v=filters[k];if(JSON.stringify(v)===JSON.stringify(defaults[k]))continue;params.set(k,Array.isArray(v)?v.join(','):String(v));}return params.toString();}
export function decodeFilters(hash,models){
 const value=hash.replace(/^#/,'');if(models.includes(value))return {...defaultFilters(),models:[value]};
 const params=new URLSearchParams(value),raw={};for(const [k,v] of params){if(!filterKeys.includes(k))continue;raw[k]=k==='models'?v.split(','):typeof defaultFilters()[k]==='boolean'?v==='true':v;}
 return sanitizeFilters(raw,models);
}
function searchText(o){return [o.title,o.modelName,o.seller,o.vin,o.engine,o.body,o.transmission,o.location?.city,o.location?.voivodeship,...Object.values(o.details||{})].join(' ').toLocaleLowerCase('pl');}
export function filterOffers(offers,f,{meta=()=>({}),origin=null,now=Date.now()}={}){
 const source=o=>(o.urls||[]).map(x=>{try{return new URL(x.url).hostname.replace(/^www\./,'');}catch{return '';}});
 return offers.filter(o=>{
  if(f.models.length&&!f.models.includes(o.modelKey))return false;
  if(f.q&&!searchText(o).includes(f.q.toLocaleLowerCase('pl').trim()))return false;
  for(const [field,key,compare] of [['price','maxPrice',(v,l)=>v<=l],['mileage','maxMileage',(v,l)=>v<=l],['year','minYear',(v,l)=>v>=l],['year','maxYear',(v,l)=>v<=l]]){
   if(f[key]!==''&&(!Number.isFinite(o[field])?!f.includeUnknown:!compare(o[field],+f[key])))return false;
  }
  if(f.transmission&&o.displayTransmission!==f.transmission)return false;
  if(f.body&&o.displayBody!==f.body)return false;
  if(f.engine&&(o.engineVariant||o.engine||'unknown')!==f.engine)return false;
  if(f.camera&&(o.cameraStatus||'unknown')!==f.camera)return false;
  if(f.lpg&&(o.lpgInstalled===true?'yes':o.lpgInstalled===false?'no':'unknown')!==f.lpg)return false;
  if(f.source&&!source(o).includes(f.source))return false;
  if(f.verdict&&o.verdict!==f.verdict)return false;
  if(f.availability&&availability(o)!==f.availability)return false;
  if(f.freshness&&freshness(o,now)!==f.freshness)return false;
  if(f.status&&(meta(o).status||'considering')!==f.status)return false;
  if(f.onlyNew&&!o.isNew)return false;
  if(f.radius!==''){const d=distance(o,origin);if(d===null||d>+f.radius)return false;}
  return true;
 });
}
export function sortOffers(list,sort,origin){
 const number=(v,fallback)=>Number.isFinite(v)?v:fallback;
 const stamp=v=>Date.parse(v)||0;
 return [...list].sort((a,b)=>{
  let result=0;
  if(sort==='priceAsc')result=number(a.price,Infinity)-number(b.price,Infinity);
  else if(sort==='priceDesc')result=number(b.price,-Infinity)-number(a.price,-Infinity);
  else if(sort==='mileageAsc')result=number(a.mileage,Infinity)-number(b.mileage,Infinity);
  else if(sort==='yearDesc')result=number(b.year,0)-number(a.year,0);
  else if(sort==='newest')result=stamp(b.firstSeenAt)-stamp(a.firstSeenAt);
  else if(sort==='checked')result=stamp(b.lastCheckedAt)-stamp(a.lastCheckedAt);
  else if(sort==='distance')result=number(distance(a,origin),Infinity)-number(distance(b,origin),Infinity);
  else result=({match:0,check:1,fail:2}[a.verdict]??1)-({match:0,check:1,fail:2}[b.verdict]??1)||number(a.price,Infinity)-number(b.price,Infinity);
  return (Number.isNaN(result)?0:result)||a.key.localeCompare(b.key);
 });
}
export function stableJSON(value){return JSON.stringify(value,function(k,item){return item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item;});}
export function applyAssessment(o,report,valid){
 const current=valid&&report.assessments?.find(a=>a.id===o.id&&a.modelKey===o.modelKey&&a.input&&Object.keys(a.input).length&&Object.entries(a.input).every(([k,v])=>stableJSON(o[k]??null)===stableJSON(v)));
 if(current)return {...o,verdict:current.verdict,assessment:current,assessmentCurrent:true,assessmentDate:report.generatedAt};
 return {...o,verdict:'check',previousVerdict:o.verdict,assessment:{failures:[],unknowns:['Ocena wymaga ponownego przeliczenia według bieżących danych.'],preferenceNotes:[]},assessmentCurrent:false};
}
