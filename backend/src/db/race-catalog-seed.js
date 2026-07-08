const pg = require('./postgres');

const RACES = [
  { id: 'nyc-marathon-2026-11-01', name: 'TCS New York City Marathon', race_date: '2026-11-01', city: 'New York', state: 'NY', distance_miles: 26.2, event_type: 'marathon', scope: 'national', source: 'NYRR', url: 'https://www.nyrr.org/tcsnycmarathon', lat: 40.7128, lng: -74.0060, elevation_gain_ft: 810, max_altitude_ft: 260, terrain: 'road' },
  { id: 'bank-of-america-chicago-marathon-2026-10-11', name: 'Bank of America Chicago Marathon', race_date: '2026-10-11', city: 'Chicago', state: 'IL', distance_miles: 26.2, event_type: 'marathon', scope: 'national', source: 'Chicago Marathon', url: 'https://www.chicagomarathon.com/', lat: 41.8781, lng: -87.6298, elevation_gain_ft: 240, max_altitude_ft: 610, terrain: 'road' },
  { id: 'marine-corps-marathon-2026-10-25', name: 'Marine Corps Marathon', race_date: '2026-10-25', city: 'Arlington', state: 'VA', distance_miles: 26.2, event_type: 'marathon', scope: 'national', source: 'Marine Corps Marathon Organization', url: 'https://www.marinemarathon.com/', lat: 38.8799, lng: -77.1068, elevation_gain_ft: 620, max_altitude_ft: 210, terrain: 'road' },
  { id: 'boston-marathon-2027-04-19', name: 'Boston Marathon', race_date: '2027-04-19', city: 'Boston', state: 'MA', distance_miles: 26.2, event_type: 'marathon', scope: 'national', source: 'Boston Athletic Association', url: 'https://www.baa.org/races/boston-marathon', lat: 42.3601, lng: -71.0589, elevation_gain_ft: 815, max_altitude_ft: 490, terrain: 'road' },
  { id: 'chevron-houston-marathon-2027-01-17', name: 'Chevron Houston Marathon', race_date: '2027-01-17', city: 'Houston', state: 'TX', distance_miles: 26.2, event_type: 'marathon', scope: 'national', source: 'Houston Marathon Committee', url: 'https://www.chevronhoustonmarathon.com/', lat: 29.7604, lng: -95.3698, elevation_gain_ft: 250, max_altitude_ft: 105, terrain: 'road' },
  { id: 'los-angeles-marathon-2027-03-21', name: 'Los Angeles Marathon', race_date: '2027-03-21', city: 'Los Angeles', state: 'CA', distance_miles: 26.2, event_type: 'marathon', scope: 'national', source: 'The McCourt Foundation', url: 'https://www.lamarathon.com/', lat: 34.0522, lng: -118.2437, elevation_gain_ft: 950, max_altitude_ft: 520, terrain: 'road' },
  { id: 'walt-disney-world-marathon-2027-01-10', name: 'Walt Disney World Marathon', race_date: '2027-01-10', city: 'Lake Buena Vista', state: 'FL', distance_miles: 26.2, event_type: 'marathon', scope: 'national', source: 'runDisney', url: 'https://www.rundisney.com/events/disneyworld/disneyworld-marathon-weekend/', lat: 28.3772, lng: -81.5707, elevation_gain_ft: 260, max_altitude_ft: 125, terrain: 'road' },
  { id: 'austin-marathon-2027-02-14', name: 'Austin Marathon', race_date: '2027-02-14', city: 'Austin', state: 'TX', distance_miles: 26.2, event_type: 'marathon', scope: 'regional', source: 'Austin Marathon', url: 'https://youraustinmarathon.com/', lat: 30.2672, lng: -97.7431, elevation_gain_ft: 1100, max_altitude_ft: 760, terrain: 'road' },
  { id: 'philadelphia-marathon-2026-11-22', name: 'Philadelphia Marathon', race_date: '2026-11-22', city: 'Philadelphia', state: 'PA', distance_miles: 26.2, event_type: 'marathon', scope: 'regional', source: 'Philadelphia Marathon Weekend', url: 'https://www.philadelphiamarathon.com/', lat: 39.9526, lng: -75.1652, elevation_gain_ft: 650, max_altitude_ft: 175, terrain: 'road' },
  { id: 'cim-2026-12-06', name: 'California International Marathon', race_date: '2026-12-06', city: 'Sacramento', state: 'CA', distance_miles: 26.2, event_type: 'marathon', scope: 'regional', source: 'Sacramento Running Association', url: 'https://runsra.org/california-international-marathon/', lat: 38.5816, lng: -121.4944, elevation_gain_ft: 340, max_altitude_ft: 370, terrain: 'road' },
  { id: 'grandmas-marathon-2027-06-19', name: "Grandma's Marathon", race_date: '2027-06-19', city: 'Duluth', state: 'MN', distance_miles: 26.2, event_type: 'marathon', scope: 'regional', source: "Grandma's Marathon", url: 'https://grandmasmarathon.com/', lat: 46.7867, lng: -92.1005, elevation_gain_ft: 430, max_altitude_ft: 675, terrain: 'road' },
  { id: 'flying-pig-marathon-2027-05-02', name: 'Flying Pig Marathon', race_date: '2027-05-02', city: 'Cincinnati', state: 'OH', distance_miles: 26.2, event_type: 'marathon', scope: 'regional', source: 'Flying Pig Marathon', url: 'https://flyingpigmarathon.com/', lat: 39.1031, lng: -84.5120, elevation_gain_ft: 1200, max_altitude_ft: 900, terrain: 'road' },
  { id: 'richmond-marathon-2026-11-14', name: 'Richmond Marathon', race_date: '2026-11-14', city: 'Richmond', state: 'VA', distance_miles: 26.2, event_type: 'marathon', scope: 'regional', source: 'Sports Backers', url: 'https://www.richmondmarathon.org/', lat: 37.5407, lng: -77.4360, elevation_gain_ft: 700, max_altitude_ft: 300, terrain: 'road' },
  { id: 'st-jude-memphis-marathon-2026-12-05', name: 'St. Jude Memphis Marathon', race_date: '2026-12-05', city: 'Memphis', state: 'TN', distance_miles: 26.2, event_type: 'marathon', scope: 'regional', source: 'St. Jude Memphis Marathon Weekend', url: 'https://www.stjude.org/get-involved/fitness-fundraisers/memphis-marathon.html', lat: 35.1495, lng: -90.0490, elevation_gain_ft: 650, max_altitude_ft: 340, terrain: 'road' },
  { id: 'seattle-marathon-2026-11-29', name: 'Seattle Marathon', race_date: '2026-11-29', city: 'Seattle', state: 'WA', distance_miles: 26.2, event_type: 'marathon', scope: 'regional', source: 'Seattle Marathon Association', url: 'https://www.seattlemarathon.org/', lat: 47.6062, lng: -122.3321, elevation_gain_ft: 1200, max_altitude_ft: 520, terrain: 'road' },
  { id: 'miami-marathon-2027-01-31', name: 'Miami Marathon', race_date: '2027-01-31', city: 'Miami', state: 'FL', distance_miles: 26.2, event_type: 'marathon', scope: 'regional', source: 'Miami Marathon', url: 'https://www.themiamimarathon.com/', lat: 25.7617, lng: -80.1918, elevation_gain_ft: 250, max_altitude_ft: 55, terrain: 'road' },
  { id: 'hot-chocolate-15k-chicago-2026-11-08', name: 'Hot Chocolate 15K Chicago', race_date: '2026-11-08', city: 'Chicago', state: 'IL', distance_miles: 9.3, event_type: '15k', scope: 'regional', source: 'Hot Chocolate Run', url: 'https://hotchocolate15k.com/city/chicago/', lat: 41.8781, lng: -87.6298, elevation_gain_ft: 90, max_altitude_ft: 610, terrain: 'road' },
  { id: 'atlanta-journal-constitution-peachtree-road-race-2027-07-04', name: 'Atlanta Journal-Constitution Peachtree Road Race', race_date: '2027-07-04', city: 'Atlanta', state: 'GA', distance_miles: 6.2, event_type: '10k', scope: 'national', source: 'Atlanta Track Club', url: 'https://www.atlantatrackclub.org/peachtree', lat: 33.7490, lng: -84.3880, elevation_gain_ft: 430, max_altitude_ft: 1050, terrain: 'road' },
  { id: 'cherry-blossom-10-mile-2027-04-04', name: 'Credit Union Cherry Blossom 10 Mile', race_date: '2027-04-04', city: 'Washington', state: 'DC', distance_miles: 10.0, event_type: '10 mile', scope: 'national', source: 'Cherry Blossom', url: 'https://www.cherryblossom.org/', lat: 38.9072, lng: -77.0369, elevation_gain_ft: 120, max_altitude_ft: 45, terrain: 'road' },
  { id: 'broad-street-run-2027-05-02', name: 'Independence Blue Cross Broad Street Run', race_date: '2027-05-02', city: 'Philadelphia', state: 'PA', distance_miles: 10.0, event_type: '10 mile', scope: 'national', source: 'Broad Street Run', url: 'https://www.broadstreetrun.com/', lat: 39.9526, lng: -75.1652, elevation_gain_ft: 110, max_altitude_ft: 150, terrain: 'road' },
  { id: 'united-airlines-nyc-half-2027-03-21', name: 'United Airlines NYC Half', race_date: '2027-03-21', city: 'New York', state: 'NY', distance_miles: 13.1, event_type: 'half marathon', scope: 'national', source: 'NYRR', url: 'https://www.nyrr.org/races/unitedairlinesnychalf', lat: 40.7128, lng: -74.0060, elevation_gain_ft: 390, max_altitude_ft: 150, terrain: 'road' },
  { id: 'brooklyn-half-2027-05-15', name: 'RBC Brooklyn Half', race_date: '2027-05-15', city: 'Brooklyn', state: 'NY', distance_miles: 13.1, event_type: 'half marathon', scope: 'regional', source: 'NYRR', url: 'https://www.nyrr.org/races/rbcbrooklynhalf', lat: 40.6782, lng: -73.9442, elevation_gain_ft: 240, max_altitude_ft: 135, terrain: 'road' },
  { id: 'falmouth-road-race-2026-08-16', name: 'ASICS Falmouth Road Race', race_date: '2026-08-16', city: 'Falmouth', state: 'MA', distance_miles: 7.0, event_type: '7 mile', scope: 'national', source: 'Falmouth Road Race', url: 'https://falmouthroadrace.com/', lat: 41.5532, lng: -70.6086, elevation_gain_ft: 250, max_altitude_ft: 110, terrain: 'road' },
  { id: 'army-10-miler-2026-10-11', name: 'Army 10-Miler', race_date: '2026-10-11', city: 'Washington', state: 'DC', distance_miles: 10.0, event_type: '10 mile', scope: 'local', source: 'Army Ten-Miler', url: 'https://www.armytenmiler.com/', lat: 38.9072, lng: -77.0369, elevation_gain_ft: 190, max_altitude_ft: 100, terrain: 'road' },
  { id: 'baltimore-running-festival-half-2026-10-17', name: 'Baltimore Running Festival Half Marathon', race_date: '2026-10-17', city: 'Baltimore', state: 'MD', distance_miles: 13.1, event_type: 'half marathon', scope: 'local', source: 'Baltimore Running Festival', url: 'https://www.thebaltimoremarathon.com/', lat: 39.2904, lng: -76.6122, elevation_gain_ft: 650, max_altitude_ft: 360, terrain: 'road' },
  { id: 'detroit-free-press-half-marathon-2026-10-18', name: 'Detroit Free Press Half Marathon', race_date: '2026-10-18', city: 'Detroit', state: 'MI', distance_miles: 13.1, event_type: 'half marathon', scope: 'regional', source: 'Detroit Free Press Marathon', url: 'https://www.freepmarathon.com/', lat: 42.3314, lng: -83.0458, elevation_gain_ft: 220, max_altitude_ft: 650, terrain: 'road' },
  { id: 'indianapolis-monumental-half-marathon-2026-11-07', name: 'Indianapolis Monumental Half Marathon', race_date: '2026-11-07', city: 'Indianapolis', state: 'IN', distance_miles: 13.1, event_type: 'half marathon', scope: 'regional', source: 'Monumental Marathon', url: 'https://monumentalmarathon.com/', lat: 39.7684, lng: -86.1581, elevation_gain_ft: 170, max_altitude_ft: 770, terrain: 'road' },
  { id: 'cowtown-half-marathon-2027-02-28', name: 'Cowtown Half Marathon', race_date: '2027-02-28', city: 'Fort Worth', state: 'TX', distance_miles: 13.1, event_type: 'half marathon', scope: 'local', source: 'The Cowtown', url: 'https://cowtownmarathon.org/', lat: 32.7555, lng: -97.3308, elevation_gain_ft: 500, max_altitude_ft: 750, terrain: 'road' },
  { id: 'bolder-boulder-10k-2027-05-31', name: 'BOLDERBoulder 10K', race_date: '2027-05-31', city: 'Boulder', state: 'CO', distance_miles: 6.2, event_type: '10k', scope: 'regional', source: 'BOLDERBoulder', url: 'https://bb10k.bolderboulder.com/', lat: 40.0150, lng: -105.2705, elevation_gain_ft: 210, max_altitude_ft: 5430, terrain: 'road' },
  { id: 'bloomsday-run-2027-05-02', name: 'Lilac Bloomsday Run', race_date: '2027-05-02', city: 'Spokane', state: 'WA', distance_miles: 7.5, event_type: '12k', scope: 'regional', source: 'Bloomsday Run', url: 'https://www.bloomsdayrun.org/', lat: 47.6588, lng: -117.4260, elevation_gain_ft: 500, max_altitude_ft: 2050, terrain: 'road' },
  { id: 'bay-to-breakers-2027-05-16', name: 'Bay to Breakers', race_date: '2027-05-16', city: 'San Francisco', state: 'CA', distance_miles: 7.5, event_type: '12k', scope: 'regional', source: 'Bay to Breakers', url: 'https://www.baytobreakers.com/', lat: 37.7749, lng: -122.4194, elevation_gain_ft: 460, max_altitude_ft: 240, terrain: 'road' },
  { id: 'gasparilla-distance-classic-15k-2027-02-27', name: 'Publix Gasparilla Distance Classic 15K', race_date: '2027-02-27', city: 'Tampa', state: 'FL', distance_miles: 9.3, event_type: '15k', scope: 'regional', source: 'Gasparilla Distance Classic', url: 'https://rungasparilla.com/', lat: 27.9506, lng: -82.4572, elevation_gain_ft: 60, max_altitude_ft: 35, terrain: 'road' },
  { id: 'portland-shamrock-run-15k-2027-03-14', name: 'Shamrock Run Portland 15K', race_date: '2027-03-14', city: 'Portland', state: 'OR', distance_miles: 9.3, event_type: '15k', scope: 'local', source: 'Shamrock Run Portland', url: 'https://www.shamrockrunportland.com/', lat: 45.5152, lng: -122.6784, elevation_gain_ft: 950, max_altitude_ft: 1050, terrain: 'road' }
];

async function seedRaceCatalog() {
  for (const race of RACES) {
    await pg.query(
      `INSERT INTO race_catalog (
        id, name, race_date, city, state, country, distance_miles, event_type,
        scope, source, url, lat, lng, elevation_gain_ft, max_altitude_ft, terrain,
        course_profile_json
      )
      VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'USA'), $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (id) DO UPDATE SET
        elevation_gain_ft = EXCLUDED.elevation_gain_ft,
        max_altitude_ft = EXCLUDED.max_altitude_ft,
        terrain = EXCLUDED.terrain`,
      [
        race.id,
        race.name,
        race.race_date,
        race.city || null,
        race.state || null,
        race.country || 'USA',
        race.distance_miles,
        race.event_type || null,
        race.scope || 'regional',
        race.source || null,
        race.url || null,
        race.lat || null,
        race.lng || null,
        race.elevation_gain_ft || null,
        race.max_altitude_ft || null,
        race.terrain || null,
        race.course_profile_json || null
      ]
    );
  }
}

module.exports = { seedRaceCatalog, RACES };
