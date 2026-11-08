import {statuses,identityKeys} from './core.mjs?v=9';
export const STORE_KEY='carOffersPersonalV1';
const empty=()=>({version:1,records:Object.create(null),searches:[],filters:null,origin:null,comparison:[]});
export function validateBackup(value){
 if(!value||value.version!==1||!value.records||Array.isArray(value.records)||typeof value.records!=='object')throw Error('Nieobsługiwany format kopii.');
 if(Object.keys(value.records).length>10000)throw Error('Kopia jest zbyt duża.');
 const clean=empty();
 for(const [key,record] of Object.entries(value.records)){
  if(!/^(id:|vin:|listing:|url:|conflict:)/.test(key)||key.length>2000||!record||typeof record!=='object'||typeof record.note!=='string'||record.note.length>20000||typeof record.favorite!=='boolean'||!Object.hasOwn(statuses,record.status)||!Number.isFinite(Date.parse(record.updatedAt)))throw Error('Nieprawidłowy wpis w kopii.');
  clean.records[key]={note:record.note,favorite:record.favorite,status:record.status,updatedAt:record.updatedAt};
 }
 if(Array.isArray(value.searches))clean.searches=value.searches.filter(s=>s&&typeof s.name==='string'&&s.name.length<=100&&typeof s.query==='string'&&s.query.length<20000).slice(0,30).map(s=>({name:s.name,query:s.query}));
 if(value.filters&&typeof value.filters==='object')clean.filters=value.filters;
 if(value.origin&&Number.isFinite(value.origin.lat)&&Number.isFinite(value.origin.lon)&&Math.abs(value.origin.lat)<=90&&Math.abs(value.origin.lon)<=180){clean.origin={lat:value.origin.lat,lon:value.origin.lon};for(const key of ['name','cityId','sourceUrl'])if(typeof value.origin[key]==='string'&&value.origin[key].length<300)clean.origin[key]=value.origin[key];}
 if(Array.isArray(value.comparison))clean.comparison=value.comparison.filter(k=>typeof k==='string'&&k.length<2000).slice(0,4);
 return clean;
}
export function createStore(storage,onError=()=>{}){
 let data=empty(),blocked=false;
 try{const raw=storage.getItem(STORE_KEY);if(raw)data=validateBackup(JSON.parse(raw));}catch{blocked=true;onError('Nie udało się odczytać zapisanych danych. Oryginalny zapis nie zostanie nadpisany. Nowe zmiany pozostają w pamięci — wyeksportuj kopię.');}
 const persist=()=>{if(blocked)return false;try{storage.setItem(STORE_KEY,JSON.stringify(data));return true;}catch{onError('Przeglądarka nie pozwala zapisać danych. Zmiany pozostają tylko do zamknięcia strony — wyeksportuj kopię.');return false;}};
 const keys=o=>o.storageKeys?.length?o.storageKeys:identityKeys(o);
 const meta=o=>{
  const records=keys(o).map(k=>data.records[k]).filter(Boolean).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
  return {favorite:records.some(r=>r.favorite),note:[...new Set(records.map(r=>r.note).filter(Boolean))].join('\n\n— Połączona notatka —\n\n'),status:records[0]?.status||'considering'};
 };
 return {meta,
  update(o,patch){const record={...meta(o),...patch,updatedAt:new Date().toISOString()};for(const key of keys(o))data.records[key]=record;return persist();},
  get filters(){return data.filters;},set filters(value){data.filters=value;persist();},
  get origin(){return data.origin;},set origin(value){data.origin=value;persist();},
  get comparison(){return data.comparison;},set comparison(value){data.comparison=value.slice(0,4);persist();},
  get searches(){return data.searches;},saveSearch(name,query){data.searches=[{name,query},...data.searches.filter(s=>s.name!==name)].slice(0,30);persist();},
  deleteSearch(index){data.searches.splice(index,1);persist();},
  export(){return JSON.stringify(data,null,2);},
  import(value){const clean=validateBackup(value);for(const [key,record] of Object.entries(clean.records)){const prior=data.records[key];if(!prior){data.records[key]=record;continue;}const notes=[...new Set([prior.note,record.note].filter(Boolean))];const winner=Date.parse(record.updatedAt)>Date.parse(prior.updatedAt)?record:prior;data.records[key]={...winner,note:notes.join('\n\n— Z kopii —\n\n')};}
   data.searches=[...data.searches,...clean.searches.filter(s=>!data.searches.some(x=>x.name===s.name&&x.query===s.query))].slice(0,30);
   if(clean.filters)data.filters=clean.filters;if(clean.origin)data.origin=clean.origin;
   data.comparison=[...new Set([...data.comparison,...clean.comparison])].slice(0,4);return persist();},
  markNew(offers){try{const key='carOffersSeenV3',previous=JSON.parse(storage.getItem(key)||'null');const seen=new Set(Array.isArray(previous)?previous:[]);for(const o of offers){const own=identityKeys(o);o.isNew=previous!==null&&!own.some(k=>seen.has(k));}for(const o of offers)for(const key of identityKeys(o))seen.add(key);storage.setItem(key,JSON.stringify([...seen]));}catch{onError('Oznaczenie nowości jest niedostępne w tej przeglądarce.');}}
 };
}
