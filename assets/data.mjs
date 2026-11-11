import {normalize,stableJSON,applyAssessment,attachLocation} from './core.mjs?v=10';
async function json(path){const response=await fetch(new URL('../'+path,import.meta.url),{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error(`${path} (HTTP ${response.status})`);return response.json();}
export async function loadData(){
 const [index,requirements,catalog,sources]=await Promise.all(['models.json','config/requirements.json','config/search-models.json','config/sources.json'].map(json));
 const models=(index.models||[]).filter(m=>/^[a-z0-9-]+$/.test(m.key)&&/^offers\/[a-z0-9-]+\.json$/.test(m.file));
 const modelRequirements=new Map((catalog.models||[]).map(model=>[model.key,model.requirements]));for(const model of models)model.searchRequirements=modelRequirements.get(model.key)||requirements;
 if(!models.length)throw Error('Brak poprawnego katalogu modeli.');
 const [results,report,dashboard,cityCatalog,locations,recommendationReport]=await Promise.all([
  Promise.allSettled(models.map(m=>json(m.file))),json('reports/current-assessment.json').catch(()=>null),json('reports/dashboard.json').catch(()=>null),
  json('data/cities-pl.json').catch(()=>null),json('data/offer-locations.json').catch(()=>null),json('reports/recommendations.json').catch(()=>null)
 ]);
 const reportValid=Boolean(report?.generatedAt&&stableJSON(report.configuration?.requirements)===stableJSON(requirements)&&stableJSON(report.configuration?.models)===stableJSON(catalog));
 const warnings=[],offers=[],archivedOffers=[];
 results.forEach((result,i)=>{const model=models[i];if(result.status==='rejected'||!Array.isArray(result.value?.offers)){model.loadError=true;warnings.push('Nie udało się wczytać ofert: '+model.name);return;}
  model.count=result.value.offers.length;model.updatedAt=result.value.updatedAt;
  offers.push(...result.value.offers.map(o=>applyAssessment(normalize(attachLocation(o,locations?.locations?.[o.id]),model),report,reportValid)));
  archivedOffers.push(...(Array.isArray(result.value.archivedOffers)?result.value.archivedOffers:[]).map(o=>applyAssessment(normalize(attachLocation(o,locations?.locations?.[o.id]),model),report,reportValid)));
 });
 if(!cityCatalog)warnings.push('Lista miast jest niedostępna. Możesz podać własny punkt w ustawieniach.');
 return {models,requirements,catalog,sources:sources.sources||[],sourceDefinitions:sources.statusDefinitions||{},offers,archivedOffers,warnings,reportValid,reportDate:report?.generatedAt,dashboard,cities:cityCatalog?.cities||[],recommendationReport};
}
export async function loadKnowledge(model){if(!/^knowledge\/models\/[a-z0-9-]+\.json$/.test(model.knowledgeFile))throw Error('Nieprawidłowa ścieżka karty wiedzy.');return json(model.knowledgeFile);}
