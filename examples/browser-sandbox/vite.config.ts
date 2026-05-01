import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  },
  optimizeDeps: {
    include: []
  },
  resolve: {
    alias: {
      // Polyfills for Node.js globals in browser
      buffer: 'buffer',
      stream: 'stream-browserify',
      crypto: 'crypto-browserify',
      http: 'stream-http',
      https: 'https-browserify',
      url: 'url'
    }
  },
  define: {
    global: 'globalThis',
    'process.env': '{}'
  }
});
