// Venues we track. `platform` picks the adapter in src/adapters; `config` is
// passed to it. How each ID was found is in README.md ("Adding a venue").
// `lat`/`lng` are postcode centroids (postcodes.io) unless noted.

const CSB = 'SH0vNlUuu9dpOHIFCYOQ'; // Community Sauna Baths' Periode merchant id
const CSB_BOOK = 'https://www.community-sauna.co.uk/book';

export const VENUES = [
  {
    id: 'druid-street', venue: 'Druid Street Saunas', site: 'Bermondsey', platform: 'bookee',
    address: '132 Druid St, London SE1 2HH', lat: 51.49911, lng: -0.07368,
    url: 'https://www.druidstreetsaunas.co.uk/schedule',
    config: { urlPrefix: 'druidstreetsaunas', regionId: 2161 },
  },
  {
    id: 'sauna-social-club-peckham', venue: 'Sauna Social Club', site: 'Peckham', platform: 'bookee',
    address: 'Brayards Rd, London SE15 2AG', lat: 51.46894, lng: -0.06097,
    url: 'https://www.saunasocialclub.co.uk/book',
    config: { urlPrefix: 'saunasocialclub', regionId: 1383 },
  },

  {
    id: 'csb-hackney-wick', venue: 'Community Sauna Baths', site: 'Hackney Wick', platform: 'periode',
    address: 'Eastway Baths, 80 Eastway, London E9 5JH', lat: 51.54767, lng: -0.02831, url: CSB_BOOK,
    config: { merchantId: CSB, groupIds: ['Zt55HgzlhPsKz8toXAAz'] },
  },
  {
    id: 'csb-stratford', venue: 'Community Sauna Baths', site: 'Stratford', platform: 'periode',
    address: 'Penny Brookes St, London E20 1LB', lat: 51.54595, lng: -0.01148, url: CSB_BOOK,
    config: { merchantId: CSB, groupIds: ['frKBWNRIEfLLd4rgSSXn'] },
  },
  {
    id: 'csb-walthamstow', venue: 'Community Sauna Baths', site: 'Walthamstow', platform: 'periode',
    address: '47 Sutherland Rd, London E17 6BH', lat: 51.59182, lng: -0.03875, url: CSB_BOOK,
    config: { merchantId: CSB, groupIds: ['Z6Kqd0ODTjRGDunx1Sop'] },
  },
  {
    id: 'csb-camberwell', venue: 'Community Sauna Baths', site: 'Camberwell', platform: 'periode',
    address: 'Ruskin Park, Denmark Hill, London SE5 8EL', lat: 51.46508, lng: -0.09076, url: CSB_BOOK,
    config: { merchantId: CSB, groupIds: ['8onLepsdoq8ETUUUnSKi', 'OY2AC9JWhfIlwjFhEtJI'] },
  },
  {
    id: 'csb-peckham', venue: 'Community Sauna Baths', site: 'Peckham', platform: 'periode',
    address: 'Glengall Wharf Garden, 64 Glengall Rd, London SE15 6NF', lat: 51.4829, lng: -0.07173, url: CSB_BOOK,
    config: { merchantId: CSB, groupIds: ['dv1eJLfFfLrSMuROX1mV'] },
  },

  {
    id: 'arc-canary-wharf', venue: 'Arc', site: 'Canary Wharf', platform: 'marianatek',
    address: '1 Crossrail Place, London E14 5AR', lat: 51.50613, lng: -0.01782,
    url: 'https://www.arc-community.com/book-now',
    config: { tenant: 'arc', region: '48541', location: '48717' },
  },
  {
    id: 'hotdrop-battersea', venue: 'Hotdrop', site: 'Battersea', platform: 'arketa',
    // Coordinates from Arketa's own location record.
    address: "66 Queen's Circus, London SW8 4LL", lat: 51.47754, lng: -0.14769,
    url: 'https://hotdropsauna.uk/book',
    config: { hostId: 'NrCKCtOazfUlmPpjh1VLVgScSph2' },
  },
  {
    id: 'sauna-and-plunge-shoreditch', venue: 'Sauna & Plunge', site: 'Shoreditch', platform: 'momence',
    address: '81 Great Eastern St, London EC2A 3HU', lat: 51.52524, lng: -0.08235,
    url: 'https://saunaandplunge.life/book-now/',
    config: { boardId: 79524, serviceId: 110021, durationMin: 30 },
  },

  {
    id: 'reset-islington', venue: 'Reset Sauna', site: 'Islington', platform: 'momence-schedule',
    address: '240 Upper Street, London N1 1RU', lat: 51.54527, lng: -0.10351,
    url: 'https://resetsauna.com/book-session',
    config: { hostId: 74215, locationIds: [277464] },
  },
  {
    id: 'waking-dreams-bethnal-green', venue: 'Waking Dreams', site: 'Bethnal Green', platform: 'momence-schedule',
    address: '1 Birkbeck Street, London E2 6JY', lat: 51.52575, lng: -0.0558,
    url: 'https://www.wakingdreams.co/schedule',
    config: { hostId: 31455, include: 'sauna' },
  },
  {
    id: 'urban-heat-camberwell', venue: 'Urban Heat', site: 'Camberwell', platform: 'momence-schedule',
    address: 'Camberwell Station Road, London SE5 9JN', lat: 51.47406, lng: -0.09724,
    url: 'https://www.urbanheatwellness.com/book',
    config: { hostId: 130322, include: 'sauna' },
  },
  {
    id: 'innervisions-south-bermondsey', venue: 'Innervisions Alchemy', site: 'South Bermondsey', platform: 'momence-schedule',
    address: 'Unit 1, Ilderton Wharf, Rollins Street, London SE15 1EP', lat: 51.48367, lng: -0.05035,
    url: 'https://www.innervisionsalchemy.co.uk/book-sauna',
    config: { hostId: 117308, include: 'sauna' },
  },

  {
    id: 'saunos-islington', venue: 'Saunos', site: 'Regent\'s Canal, Islington', platform: 'legitfit',
    address: 'Packington Bridge, Shepherdess Walk, London N1 7JL', lat: 51.53362, lng: -0.09366,
    url: 'https://www.legitfit.com/p/timetable/saunoslimited',
    config: { profileId: 'saunoslimited' },
  },
  {
    id: 'cabin-clapham', venue: 'The Cabin Sauna', site: 'Clapham Common', platform: 'legitfit',
    address: 'Clapham Common, London SW4 0JA', lat: 51.46242, lng: -0.14009,
    url: 'https://thecabinsauna.co.uk/#booking',
    config: { profileId: '68b04a47252948e23c0661b4' },
  },
  {
    id: 'pulse-fulham', venue: 'Pulse Club', site: 'Fulham', platform: 'legitfit',
    address: '340 North End Rd, London SW6 1NB', lat: 51.48173, lng: -0.19987,
    url: 'https://legitfit.com/p/timetable/pulseclubfulham',
    config: { profileId: 'pulseclubfulham' },
  },
  {
    id: 'pulse-putney', venue: 'Pulse Club', site: 'Putney', platform: 'legitfit',
    address: '228 Upper Richmond Rd, London SW15 6TG', lat: 51.46143, lng: -0.21898,
    url: 'https://legitfit.com/p/timetable/pulseclubputney',
    config: { profileId: 'pulseclubputney' },
  },
  {
    id: 'arvo-walthamstow', venue: 'Arvo', site: 'Walthamstow', platform: 'bookasession',
    address: '93 Shernhall Street, London E17 9HS', lat: 51.58385, lng: -0.00725,
    url: 'https://bookasession.org/arvo/l/sauna',
    config: { slug: 'arvo', locationIds: ['19842428-4db0-464f-8b22-43387fff0a33'] }, // the sauna, not the studio
  },
  {
    id: 'old-kent-road-sauna', venue: 'Old Kent Road Sauna', site: 'Peckham', platform: 'bookasession',
    address: '897a Old Kent Rd, London SE15 1NL', lat: 51.47874, lng: -0.05383,
    url: 'https://bookasession.org/okr',
    config: { slug: 'okr' },
  },
];
