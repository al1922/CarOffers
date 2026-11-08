#!/usr/bin/env python3
"""Build offline geographic data and an auditable, conservative location overlay.

Never infer a location from a seller name. Explicit historical title locations
are retained as historical claims; ambiguous place names receive no coordinates.
The original offers are not modified. Source archives stay in .cache/.
"""
import hashlib
from datetime import datetime, timezone
from pathlib import Path
import re
import unicodedata
import zipfile
from search_core import ROOT, read, write

PROVINCES = {'72':'dolnośląskie','73':'kujawsko-pomorskie','74':'łódzkie','75':'lubelskie',
 '76':'lubuskie','77':'małopolskie','78':'mazowieckie','79':'opolskie','80':'podkarpackie',
 '81':'podlaskie','82':'pomorskie','83':'śląskie','84':'świętokrzyskie','85':'warmińsko-mazurskie',
 '86':'wielkopolskie','87':'zachodniopomorskie'}


def key(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value.casefold().replace('ł','l'))
                   if not unicodedata.combining(c)).strip()


def title_place(title):
    if ' — ' not in title:
        return None
    tail = title.rsplit(' — ', 1)[1].split('·')[0]
    tail = re.sub(r',?\s+\d[\d\s\u00a0]*\s*km.*$', '', tail).strip(' ,')
    if not tail or re.match(r'\d', tail) or re.search(r'Polska|AAA|Arval|sieć|lokalizacja|potwierdzenia', tail, re.I) or '/' in tail:
        return None
    region = None
    for province in PROVINCES.values():
        if re.search(r'(?<!\w)' + re.escape(province) + r'(?!\w)', tail, re.I):
            region = province
            tail = re.sub(r'(?<!\w)' + re.escape(province) + r'(?!\w)', '', tail, flags=re.I)
            break
    # An explicitly named city and its district can be represented at city precision.
    city = re.sub(r'\([^)]*\)', '', tail).split(' – ')[0].strip(' ,()')
    return (city, region) if city and len(city) < 80 else None


def load_places(archive):
    rows = [line.split('\t') for line in zipfile.ZipFile(archive).read('PL.txt').decode('utf-8').splitlines()]
    places = []
    for row in rows:
        if row[6] != 'P' or row[7] in ('PPLH','PPLQ') or row[8] != 'PL':
            continue
        names = {row[1], row[2]}
        # Use only these documented native spellings as aliases, not arbitrary historical names.
        native = {'756135':'Warszawa','3103402':'Bielsko-Biała'}.get(row[0], row[1])
        if native != row[1] and native not in row[3].split(','):
            raise ValueError('Native name absent from source: ' + native)
        names.add(native)
        places.append({'id':row[0], 'name':native, 'aliases':sorted(names),
                       'lat':float(row[4]), 'lon':float(row[5]), 'voivodeship':PROVINCES.get(row[10]),
                       'population':int(row[14]), 'district':row[13].endswith('_8'),
                       'sourceUrl':'https://www.geonames.org/' + row[0] + '/', 'sourceModifiedAt':row[18]})
    return places


def resolve(city, province, places):
    pool = places.get(key(city), []) if isinstance(places, dict) else places
    candidates = [p for p in pool if key(city) in {key(n) for n in p['aliases']}
                  and (province is None or p['voivodeship'] == province)]
    return candidates[0] if len(candidates) == 1 else None


def generate(root=ROOT):
    archive = root / '.cache/geonames-PL.zip'
    places = load_places(archive)
    lookup = {}
    for place in places:
        for alias in {key(name) for name in place['aliases']}:
            lookup.setdefault(alias, []).append(place)
    checked = datetime.now(timezone.utc).isoformat()
    provenance = {'provider':'GeoNames', 'url':'https://download.geonames.org/export/dump/PL.zip',
                  'license':'CC BY 4.0', 'licenseUrl':'https://creativecommons.org/licenses/by/4.0/',
                  'checkedAt':checked, 'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),
                  'note':'Subset of the Poland dump. Administrative names translated into Polish. City-level points, not seller addresses.'}
    cities = sorted((p for p in places if p['population'] >= 100000 and not p['district']), key=lambda p:key(p['name']))
    write(root / 'data/cities-pl.json', {'version':1, 'provenance':provenance,
          'cities':[{k:p[k] for k in ('id','name','lat','lon','voivodeship','sourceUrl')} for p in cities]})
    verified_path = root / 'data/verified-locations.json'
    verified = read(verified_path)['observations'] if verified_path.exists() else []
    overlays, skipped, evidence_records = {}, [], []
    for path in sorted((root / 'offers').glob('*.json')):
        doc = read(path)
        for offer in doc['offers']:
            known = next((v for v in verified if v['offerId'] == offer['id'] and
                          v['sourceUrl'] in [link['url'] for link in offer.get('urls',[])]), None)
            parsed = (known['city'],known['voivodeship']) if known else title_place(offer['title'])
            if not parsed:
                skipped.append({'offerId':offer['id'], 'reason':'No unambiguous explicit location in historical title'})
                continue
            city, province = parsed
            point = resolve(city, province, lookup)
            source_url = known['sourceUrl'] if known else next((u['url'] for u in offer.get('urls',[])),None)
            if not source_url:
                skipped.append({'offerId':offer['id'], 'reason':'No listing source URL'})
                continue
            location = {'status':'available', 'countryCode':'PL', 'city':city,
                        'voivodeship':province or (point['voivodeship'] if point else None),
                        'precision':'city', 'source':'listing' if known else 'unknown',
                        'checkedAt':known['checkedAt'][:10] if known else None}
            if point:
                location.update(latitude=point['lat'],longitude=point['lon'],geoSource=point['sourceUrl'])
            evidence = {'basis':'listing_read' if known else 'historical_listing_title',
                        'sourceUrl':source_url, 'checkedAt':known['checkedAt'] if known else None,
                        'historicalTitle':offer['title'], 'sourceFile':path.relative_to(root).as_posix(),
                        'sourceFileSha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                        'historicalFileUpdatedAt':doc.get('updatedAt'),
                        'note':known['quote'] if known else 'Miejscowość zapisana jawnie w historycznym tytule. Nie sprawdzono ponownie na portalu.',
                        'geocodedAt':checked if point else None,
                        'geocodingNote':'Punkt miejscowości GeoNames; nie adres auta.' if point else 'Nazwa wieloznaczna lub brak zgodnego punktu — nie wybrano współrzędnych.'}
            overlays[offer['id']] = {'location':location,'evidence':evidence}
            evidence_records.append({'id':offer['id'],'title':offer['title'],'urls':offer.get('urls',[])})
    output={'version':1,'generatedAt':checked,'provenance':provenance,'locations':overlays,'skipped':skipped}
    write(root / 'data/offer-locations.json',output)
    # Preserve the exact evidence subset independently of mutable offer files.
    evidence_hash=hashlib.sha256(str(evidence_records).encode()).hexdigest()[:16]
    write(root / 'reports/location-evidence' / (evidence_hash+'.json'),{'records':evidence_records})
    summary={'offersWithCity':len(overlays),'offersWithCoordinates':sum('latitude' in o['location'] for o in overlays.values()),
             'recentListingReads':sum(o['evidence']['basis']=='listing_read' for o in overlays.values()),
             'notResolved':len(skipped),'originCities':len(cities)}
    write(root / 'reports/location-migration.json',{'generatedAt':checked,**summary,'skipped':skipped})
    return summary


if __name__ == '__main__':
    print(generate())
