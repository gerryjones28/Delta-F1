import { defineConfig } from 'vite'

const proxy = { '/api': { target: process.env.DELTA_API_ORIGIN || 'http://127.0.0.1:8000' } }

export default defineConfig({
  server: { proxy },
  preview: { proxy },
})
