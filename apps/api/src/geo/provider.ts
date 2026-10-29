// Address search and reverse geocoding behind an adapter.
// Production: our own Nominatim on OpenStreetMap data for Uzbekistan (no per-request fees, data stays
// with us). Development: a small built-in list of Tashkent places with APPROXIMATE coordinates.

export interface Place {
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export interface GeoProvider {
  search(q: string, near: { lat: number; lng: number } | null, lang: string): Promise<Place[]>;
  reverse(lat: number, lng: number, lang: string): Promise<Place | null>;
}

type L = { uz: string; ru: string; en: string };
// Development gazetteer — approximate coordinates, for local testing only.
const DEV_PLACES: { name: L; district: L; lat: number; lng: number }[] = [
  { name: { uz: 'Amir Temur xiyoboni', ru: 'Сквер Амира Темура', en: 'Amir Temur Square' }, district: { uz: 'Yunusobod', ru: 'Юнусабад', en: 'Yunusabad' }, lat: 41.3111, lng: 69.2797 },
  { name: { uz: 'Toshkent City Mall', ru: 'Ташкент Сити Молл', en: 'Tashkent City Mall' }, district: { uz: 'Shayxontohur', ru: 'Шайхантахур', en: 'Shaykhantakhur' }, lat: 41.3166, lng: 69.2484 },
  { name: { uz: 'Chorsu bozori', ru: 'Базар Чорсу', en: 'Chorsu Bazaar' }, district: { uz: 'Shayxontohur', ru: 'Шайхантахур', en: 'Shaykhantakhur' }, lat: 41.3266, lng: 69.235 },
  { name: { uz: 'Toshkent xalqaro aeroporti', ru: 'Международный аэропорт Ташкент', en: 'Tashkent International Airport' }, district: { uz: 'Sergeli', ru: 'Сергели', en: 'Sergeli' }, lat: 41.2579, lng: 69.2812 },
  { name: { uz: 'Toshkent temir yoʻl vokzali', ru: 'Ташкентский ж/д вокзал', en: 'Tashkent railway station' }, district: { uz: 'Mirobod', ru: 'Мирабад', en: 'Mirabad' }, lat: 41.2917, lng: 69.2867 },
  { name: { uz: 'Mega Planet', ru: 'Мега Планет', en: 'Mega Planet' }, district: { uz: 'Yunusobod', ru: 'Юнусабад', en: 'Yunusabad' }, lat: 41.3676, lng: 69.2896 },
  { name: { uz: 'Samarqand Darvoza', ru: 'Самарканд Дарвоза', en: 'Samarkand Darvoza' }, district: { uz: 'Shayxontohur', ru: 'Шайхантахур', en: 'Shaykhantakhur' }, lat: 41.3158, lng: 69.2135 },
  { name: { uz: 'Magic City', ru: 'Мэджик Сити', en: 'Magic City' }, district: { uz: 'Chilonzor', ru: 'Чиланзар', en: 'Chilanzar' }, lat: 41.303, lng: 69.247 },
  { name: { uz: 'Mustaqillik maydoni', ru: 'Площадь Независимости', en: 'Independence Square' }, district: { uz: 'Mirobod', ru: 'Мирабад', en: 'Mirabad' }, lat: 41.3146, lng: 69.2705 },
  { name: { uz: 'Oloy bozori', ru: 'Алайский базар', en: 'Alay Bazaar' }, district: { uz: 'Yunusobod', ru: 'Юнусабад', en: 'Yunusabad' }, lat: 41.324, lng: 69.2845 },
  { name: { uz: 'Chilonzor metro bekati', ru: 'Метро Чиланзар', en: 'Chilanzar metro' }, district: { uz: 'Chilonzor', ru: 'Чиланзар', en: 'Chilanzar' }, lat: 41.2771, lng: 69.2045 },
  { name: { uz: 'Toshkent teleminorasi', ru: 'Ташкентская телебашня', en: 'Tashkent TV Tower' }, district: { uz: 'Yunusobod', ru: 'Юнусабад', en: 'Yunusabad' }, lat: 41.346, lng: 69.2856 },
  { name: { uz: 'Hazrati Imom majmuasi', ru: 'Комплекс Хазрати Имам', en: 'Hazrati Imam Complex' }, district: { uz: 'Olmazor', ru: 'Алмазар', en: 'Almazar' }, lat: 41.3384, lng: 69.239 },
  { name: { uz: 'Botanika bogʻi', ru: 'Ботанический сад', en: 'Botanical Garden' }, district: { uz: 'Mirzo Ulugʻbek', ru: 'Мирзо-Улугбек', en: 'Mirzo Ulugbek' }, lat: 41.342, lng: 69.324 },
  { name: { uz: 'Sergeli', ru: 'Сергели', en: 'Sergeli' }, district: { uz: 'Sergeli', ru: 'Сергели', en: 'Sergeli' }, lat: 41.224, lng: 69.219 },
  { name: { uz: 'Kukeldosh madrasasi', ru: 'Медресе Кукельдаш', en: 'Kukeldash Madrasa' }, district: { uz: 'Shayxontohur', ru: 'Шайхантахур', en: 'Shaykhantakhur' }, lat: 41.3254, lng: 69.2381 },
];

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ'ʻʼ`’‘\-\s.]/g, '');
const pickL = (l: L, lang: string) => l[(lang as keyof L)] ?? l.uz;

function dist(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(h));
}

export class DevGeoProvider implements GeoProvider {
  async search(q: string, near: { lat: number; lng: number } | null, lang: string): Promise<Place[]> {
    const n = norm(q);
    return DEV_PLACES
      .filter((p) => [p.name.uz, p.name.ru, p.name.en, p.district.uz, p.district.ru].some((s) => norm(s).includes(n)))
      .sort((a, b) => (near ? dist(near, a) - dist(near, b) : 0))
      .slice(0, 8)
      .map((p) => ({ name: pickL(p.name, lang), address: `${pickL(p.district, lang)}, ${lang === 'ru' ? 'Ташкент' : 'Toshkent'}`, lat: p.lat, lng: p.lng }));
  }

  async reverse(lat: number, lng: number, lang: string): Promise<Place | null> {
    const near = [...DEV_PLACES].sort((a, b) => dist({ lat, lng }, a) - dist({ lat, lng }, b))[0]!;
    const d = dist({ lat, lng }, near);
    const label = d < 150 ? pickL(near.name, lang) : `${pickL(near.district, lang)}, ${Math.round(d)} m ← ${pickL(near.name, lang)}`;
    return { name: label, address: `${pickL(near.district, lang)}, ${lang === 'ru' ? 'Ташкент' : 'Toshkent'}`, lat, lng };
  }
}

/** Our own Nominatim (OpenStreetMap) instance. Results are limited to Uzbekistan. */
export class NominatimProvider implements GeoProvider {
  private readonly base: string;
  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/$/, '');
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(3000), headers: { 'user-agent': 'taxi-api' } });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    return res.json();
  }

  private static toPlace(r: Record<string, any>): Place {
    const a = r.address ?? {};
    const street = [a.road, a.house_number].filter(Boolean).join(', ');
    return {
      name: r.name || street || String(r.display_name ?? '').split(',')[0] || '',
      address: [street !== r.name ? street : null, a.suburb ?? a.city_district, a.city ?? a.town ?? a.village].filter(Boolean).join(', '),
      lat: Number(r.lat), lng: Number(r.lon),
    };
  }

  async search(q: string, near: { lat: number; lng: number } | null, lang: string): Promise<Place[]> {
    const p = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: '8', countrycodes: 'uz', 'accept-language': lang });
    if (near) p.set('viewbox', `${near.lng - 0.3},${near.lat + 0.3},${near.lng + 0.3},${near.lat - 0.3}`);
    const rows = (await this.get(`/search?${p}`)) as Record<string, any>[];
    return rows.map(NominatimProvider.toPlace);
  }

  async reverse(lat: number, lng: number, lang: string): Promise<Place | null> {
    const p = new URLSearchParams({ lat: String(lat), lon: String(lng), format: 'jsonv2', addressdetails: '1', zoom: '18', 'accept-language': lang });
    const r = (await this.get(`/reverse?${p}`)) as Record<string, any>;
    return r && r.lat ? NominatimProvider.toPlace(r) : null;
  }
}

export function createGeoProvider(kind: string, nominatimUrl: string): GeoProvider {
  return kind === 'nominatim' ? new NominatimProvider(nominatimUrl) : new DevGeoProvider();
}
