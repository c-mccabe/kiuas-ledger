// London split into six regions by postcode district, used for the home page
// tiles, /areas/<slug> pages and the region filter in the app. Districts are
// grouped the way Londoners talk about them (Fulham and Chelsea are "west",
// SW1 and W1 are "central") rather than by postcode letters alone, and outer
// postcodes (IG, TW, BR…) join the region they border.

export const REGIONS = {
  'central-london': { name: 'Central London', short: 'Central', blurb: 'The City, Shoreditch, the West End' },
  'north-london': { name: 'North London', short: 'North', blurb: 'Islington, Camden, Hackney Downs' },
  'east-london': { name: 'East London', short: 'East', blurb: 'Hackney Wick, Stratford, Walthamstow' },
  'south-east-london': { name: 'South East London', short: 'South East', blurb: 'Bermondsey, Peckham, Camberwell' },
  'south-west-london': { name: 'South West London', short: 'South West', blurb: 'Clapham, Battersea, Putney' },
  'west-london': { name: 'West London', short: 'West', blurb: 'Fulham, Chelsea, Hammersmith' },
};

const BY_AREA = {
  EC: 'central-london', WC: 'central-london',
  N: 'north-london', NW: 'north-london', EN: 'north-london', HA: 'north-london',
  E: 'east-london', IG: 'east-london', RM: 'east-london',
  SE: 'south-east-london', BR: 'south-east-london', DA: 'south-east-london', CR: 'south-east-london',
  SW: 'south-west-london', SM: 'south-west-london', KT: 'south-west-london',
  W: 'west-london', UB: 'west-london', TW: 'west-london',
};
const BY_DISTRICT = {
  W1: 'central-london', SW1: 'central-london',
  SW3: 'west-london', SW5: 'west-london', SW6: 'west-london', SW7: 'west-london', SW10: 'west-london',
};

export function regionOf(address) {
  const m = String(address ?? '').match(/\b([A-Z]{1,2})(\d{1,2})[A-Z]?\s*\d[A-Z]{2}\b/);
  if (!m) return null;
  return BY_DISTRICT[`${m[1]}${m[2]}`] ?? BY_AREA[m[1]] ?? null;
}
