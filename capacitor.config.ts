import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.ionic.starter',
  appName: 'Sippa',
  webDir: 'www',
  android: {
    path: 'android' // Le indica a Capacitor que la carpeta nativa está en './android'
  },
  plugins: {
    CapacitorSQLite: {
      androidDatabaseProvider: 'system'
    }
  }
};

export default config;
