import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const apiProxyTarget = trimTrailingSlash(env.VITE_API_BASE_URL?.trim() || 'https://inv.theredsun.org');

  return {
    base: './',
    plugins: [react()],
    resolve: {
      alias: {
        '@jingles/shared': new URL('../shared/src/index.ts', import.meta.url).pathname,
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
