"""Location recovery must never turn ambiguity or seller names into coordinates."""
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT / 'scripts'))
spec=importlib.util.spec_from_file_location('locations',ROOT / 'scripts/generate-locations.py')
locations=importlib.util.module_from_spec(spec)
spec.loader.exec_module(locations)


class LocationTests(unittest.TestCase):
    def test_explicit_city_in_title(self):
        self.assertEqual(locations.title_place('Auto — Iwkowa (Małopolskie) · 63 000 km'),('Iwkowa','małopolskie'))
        self.assertEqual(locations.title_place('Auto — Łódź  168 304 km'),('Łódź',None))
        self.assertEqual(locations.title_place('Auto — Kraków – Bronowice  262 707 km'),('Kraków',None))

    def test_seller_and_unspecified_location_are_not_city_evidence(self):
        for title in ['Auto — Polska (lokalizacja w ogłoszeniu)','Auto — AAA AUTO / Allegro, 102 777 km',
                      'Auto — 1.5 DPi · 110 KM, 121 245 km','Auto — Białki / Siedlce 234 588 km']:
            self.assertIsNone(locations.title_place(title),title)

    def test_ambiguous_names_do_not_get_coordinates(self):
        points=[{'id':'1','aliases':['Olsztyn'],'voivodeship':'śląskie'},
                {'id':'2','aliases':['Olsztyn'],'voivodeship':'warmińsko-mazurskie'}]
        self.assertIsNone(locations.resolve('Olsztyn',None,points))
        self.assertEqual(locations.resolve('Olsztyn','śląskie',points)['id'],'1')
        self.assertIsNone(locations.resolve('Olsztyn','pomorskie',points))


if __name__=='__main__':
    unittest.main()
