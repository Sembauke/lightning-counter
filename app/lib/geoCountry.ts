// Server-side country lookup from lat/lon.
// country-reverse-geocoding returns ISO alpha-3 codes; we convert to alpha-2 for flag emojis.

// Full ISO 3166-1 alpha-3 → alpha-2 mapping (embedded to avoid extra deps)
const A3_TO_A2: Record<string, string> = {
  ABW:'AW',AFG:'AF',AGO:'AO',AIA:'AI',ALA:'AX',ALB:'AL',AND:'AD',ARE:'AE',
  ARG:'AR',ARM:'AM',ASM:'AS',ATA:'AQ',ATF:'TF',ATG:'AG',AUS:'AU',AUT:'AT',
  AZE:'AZ',BDI:'BI',BEL:'BE',BEN:'BJ',BES:'BQ',BFA:'BF',BGD:'BD',BGR:'BG',
  BHR:'BH',BHS:'BS',BIH:'BA',BLM:'BL',BLR:'BY',BLZ:'BZ',BMU:'BM',BOL:'BO',
  BRA:'BR',BRB:'BB',BRN:'BN',BTN:'BT',BVT:'BV',BWA:'BW',CAF:'CF',CAN:'CA',
  CCK:'CC',CHE:'CH',CHL:'CL',CHN:'CN',CIV:'CI',CMR:'CM',COD:'CD',COG:'CG',
  COK:'CK',COL:'CO',COM:'KM',CPV:'CV',CRI:'CR',CUB:'CU',CUW:'CW',CXR:'CX',
  CYM:'KY',CYP:'CY',CZE:'CZ',DEU:'DE',DJI:'DJ',DMA:'DM',DNK:'DK',DOM:'DO',
  DZA:'DZ',ECU:'EC',EGY:'EG',ERI:'ER',ESH:'EH',ESP:'ES',EST:'EE',ETH:'ET',
  FIN:'FI',FJI:'FJ',FLK:'FK',FRA:'FR',FRO:'FO',FSM:'FM',GAB:'GA',GBR:'GB',
  GEO:'GE',GGY:'GG',GHA:'GH',GIB:'GI',GIN:'GN',GLP:'GP',GMB:'GM',GNB:'GW',
  GNQ:'GQ',GRC:'GR',GRD:'GD',GRL:'GL',GTM:'GT',GUF:'GF',GUM:'GU',GUY:'GY',
  HKG:'HK',HMD:'HM',HND:'HN',HRV:'HR',HTI:'HT',HUN:'HU',IDN:'ID',IMN:'IM',
  IND:'IN',IOT:'IO',IRL:'IE',IRN:'IR',IRQ:'IQ',ISL:'IS',ISR:'IL',ITA:'IT',
  JAM:'JM',JEY:'JE',JOR:'JO',JPN:'JP',KAZ:'KZ',KEN:'KE',KGZ:'KG',KHM:'KH',
  KIR:'KI',KNA:'KN',KOR:'KR',KWT:'KW',LAO:'LA',LBN:'LB',LBR:'LR',LBY:'LY',
  LCA:'LC',LIE:'LI',LKA:'LK',LSO:'LS',LTU:'LT',LUX:'LU',LVA:'LV',MAC:'MO',
  MAF:'MF',MAR:'MA',MCO:'MC',MDA:'MD',MDG:'MG',MDV:'MV',MEX:'MX',MHL:'MH',
  MKD:'MK',MLI:'ML',MLT:'MT',MMR:'MM',MNE:'ME',MNG:'MN',MNP:'MP',MOZ:'MZ',
  MRT:'MR',MSR:'MS',MTQ:'MQ',MUS:'MU',MWI:'MW',MYS:'MY',MYT:'YT',NAM:'NA',
  NCL:'NC',NER:'NE',NFK:'NF',NGA:'NG',NIC:'NI',NIU:'NU',NLD:'NL',NOR:'NO',
  NPL:'NP',NRU:'NR',NZL:'NZ',OMN:'OM',PAK:'PK',PAN:'PA',PCN:'PN',PER:'PE',
  PHL:'PH',PLW:'PW',PNG:'PG',POL:'PL',PRI:'PR',PRK:'KP',PRT:'PT',PRY:'PY',
  PSE:'PS',PYF:'PF',QAT:'QA',REU:'RE',ROU:'RO',RUS:'RU',RWA:'RW',SAU:'SA',
  SDN:'SD',SEN:'SN',SGP:'SG',SGS:'GS',SHN:'SH',SJM:'SJ',SLB:'SB',SLE:'SL',
  SLV:'SV',SMR:'SM',SOM:'SO',SPM:'PM',SRB:'RS',SSD:'SS',STP:'ST',SUR:'SR',
  SVK:'SK',SVN:'SI',SWE:'SE',SWZ:'SZ',SXM:'SX',SYC:'SC',SYR:'SY',TCA:'TC',
  TCD:'TD',TGO:'TG',THA:'TH',TJK:'TJ',TKL:'TK',TKM:'TM',TLS:'TL',TON:'TO',
  TTO:'TT',TUN:'TN',TUR:'TR',TUV:'TV',TWN:'TW',TZA:'TZ',UGA:'UG',UKR:'UA',
  UMI:'UM',URY:'UY',USA:'US',UZB:'UZ',VAT:'VA',VCT:'VC',VEN:'VE',VGB:'VG',
  VIR:'VI',VNM:'VN',VUT:'VU',WLF:'WF',WSM:'WS',YEM:'YE',ZAF:'ZA',ZMB:'ZM',
  ZWE:'ZW',
};

// Ray-casting point-in-polygon test.
// poly is an array of [lon, lat] vertices.
function pip(lat: number, lon: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Simplified border polygons for micro-states omitted by country-reverse-geocoding.
// Vertices are [lon, lat] pairs. Good enough for lightning-strike attribution.
const MICRO_STATES: Array<{ code: string; poly: [number, number][] }> = [
  {
    // Andorra — nestled in the Pyrenees between France and Spain
    code: 'AD',
    poly: [
      [1.420, 42.465], [1.465, 42.433], [1.545, 42.429], [1.660, 42.450],
      [1.742, 42.450], [1.787, 42.507], [1.740, 42.581], [1.718, 42.613],
      [1.660, 42.641], [1.609, 42.656], [1.508, 42.656], [1.418, 42.640],
      [1.408, 42.560],
    ],
  },
  {
    // Monaco — tiny city-state on the French Riviera
    code: 'MC',
    poly: [
      [7.376, 43.724], [7.440, 43.724], [7.440, 43.752], [7.376, 43.752],
    ],
  },
  {
    // San Marino — enclave within central Italy
    code: 'SM',
    poly: [
      [12.393, 43.893], [12.467, 43.893], [12.516, 43.942], [12.516, 43.988],
      [12.452, 43.992], [12.406, 43.960], [12.393, 43.920],
    ],
  },
  {
    // Liechtenstein — narrow strip between Switzerland and Austria
    code: 'LI',
    poly: [
      [9.471, 47.058], [9.576, 47.058], [9.636, 47.119], [9.622, 47.270],
      [9.545, 47.270], [9.471, 47.220],
    ],
  },
  {
    // Vatican City — enclave within Rome
    code: 'VA',
    poly: [
      [12.435, 41.895], [12.465, 41.895], [12.465, 41.910], [12.435, 41.910],
    ],
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _crg: any = null;

export function getCountryCode(lat: number, lon: number): string | null {
  // Check micro-states first — the library's simplified polygons omit them entirely.
  for (const { code, poly } of MICRO_STATES) {
    if (pip(lat, lon, poly)) return code;
  }

  if (!_crg) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _crg = require('country-reverse-geocoding').country_reverse_geocoding();
  }
  const r = _crg.get_country(lat, lon) as { code: string; name: string } | null;
  if (!r) return null;
  return A3_TO_A2[r.code] ?? null;
}
