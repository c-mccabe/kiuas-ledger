// Venues we track. `platform` picks the adapter in src/adapters; `config` is
// passed to it. How each ID was found is in README.md ("Adding a venue").

const CSB = 'SH0vNlUuu9dpOHIFCYOQ'; // Community Sauna Baths' Periode merchant id

export const VENUES = [
  { venue: 'Druid Street Saunas', site: 'Bermondsey', platform: 'bookee', config: { urlPrefix: 'druidstreetsaunas', regionId: 2161 } },
  { venue: 'Sauna Social Club', site: 'Peckham', platform: 'bookee', config: { urlPrefix: 'saunasocialclub', regionId: 1383 } },

  { venue: 'Community Sauna Baths', site: 'Hackney Wick', platform: 'periode', config: { merchantId: CSB, groupIds: ['Zt55HgzlhPsKz8toXAAz'] } },
  { venue: 'Community Sauna Baths', site: 'Stratford', platform: 'periode', config: { merchantId: CSB, groupIds: ['frKBWNRIEfLLd4rgSSXn'] } },
  { venue: 'Community Sauna Baths', site: 'Walthamstow', platform: 'periode', config: { merchantId: CSB, groupIds: ['Z6Kqd0ODTjRGDunx1Sop'] } },
  { venue: 'Community Sauna Baths', site: 'Camberwell', platform: 'periode', config: { merchantId: CSB, groupIds: ['8onLepsdoq8ETUUUnSKi', 'OY2AC9JWhfIlwjFhEtJI'] } },
  { venue: 'Community Sauna Baths', site: 'Peckham', platform: 'periode', config: { merchantId: CSB, groupIds: ['dv1eJLfFfLrSMuROX1mV'] } },

  { venue: 'Arc', site: 'Canary Wharf', platform: 'marianatek', config: { tenant: 'arc', region: '48541', location: '48717' } },
  { venue: 'Hotdrop', site: 'Battersea', platform: 'arketa', config: { hostId: 'NrCKCtOazfUlmPpjh1VLVgScSph2' } },
  { venue: 'Sauna & Plunge', site: 'Shoreditch', platform: 'momence', config: { boardId: 79524, serviceId: 110021, durationMin: 30 } },

  { venue: 'The Cabin Sauna', site: 'Clapham Common', platform: 'legitfit', config: { profileId: '68b04a47252948e23c0661b4' } },
  { venue: 'Pulse Club', site: 'Fulham', platform: 'legitfit', config: { profileId: 'pulseclubfulham' } },
  { venue: 'Pulse Club', site: 'Putney', platform: 'legitfit', config: { profileId: 'pulseclubputney' } },
];
