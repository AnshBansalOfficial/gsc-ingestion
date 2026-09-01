import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Builds straight into the Spring Boot service's static resources, so the Java app is
 * the only thing that has to be running at demo time. The built output is committed for
 * the same reason: `mvn spring-boot:run` alone is enough, with no Node step.
 *
 * `npm run dev` proxies /api to the Java service so the console can be developed with
 * hot reload against the real backend.
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../demo-app/src/main/resources/static',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080' },
  },
});
