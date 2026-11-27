import { defineConfig } from 'vite'

const proxy = { '/api': { target: process.env.DELTA_API_ORIGIN || 'http://127.0.0.1:8000' } }

export default defineConfig({
  build: { rollupOptions: { input: { app: 'index.html', studio: 'studio-still.html' } } },
  server: { proxy, fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local-vehicle/**', '**/*.{blend,rar}'] } },
  preview: { proxy },
})
