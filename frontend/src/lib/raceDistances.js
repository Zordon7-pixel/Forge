export const STANDARD_RACE_DISTANCES = Object.freeze([
  { key: '1 Mile', label: '1 Mile', miles: 1 },
  { key: '5K', label: '5K', miles: 3.107 },
  { key: '10K', label: '10K', miles: 6.214 },
  { key: '15K', label: '15K', miles: 9.321 },
  { key: '10 Mile', label: '10 Mile', miles: 10 },
  { key: 'Half Marathon', label: 'Half Marathon', miles: 13.109 },
  { key: 'Marathon', label: 'Marathon', miles: 26.219 },
])

export const RACE_DISTANCE_OPTIONS = Object.freeze({
  ...Object.fromEntries(STANDARD_RACE_DISTANCES.map(({ key, miles }) => [key, miles])),
  Other: null,
})
