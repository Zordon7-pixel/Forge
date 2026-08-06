import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.zordontech.forge',
  appName: 'Forged Hybrid',
  webDir: 'dist',
  server: {
    // Live-load from Railway so TestFlight always gets the latest web build
    // without needing a new TestFlight submission for every UI change.
    url: 'https://forge-production-773f.up.railway.app',
    cleartext: false,
    androidScheme: 'https',
  },
};

export default config;
