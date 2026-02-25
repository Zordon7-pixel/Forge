import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.forgeathlete',
  appName: 'FORGE',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  }
};

export default config;
