import { defineConfig } from 'vite'
import { existsSync, createReadStream, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const proxy = { '/api': { target: process.env.DELTA_API_ORIGIN || 'http://127.0.0.1:8000' } }
const directory = fileURLToPath(new URL('./.local-vehicle/', import.meta.url))
const vehicleFiles = new Set(['vehicle.glb', 'vehicle-compact.glb', 'sculpture.webp', 'studio-descent.webp', 'studio-overhead.webp'])

function serveLocalVehicle(server) {
  server.middlewares.use('/local-vehicle', (request, response, next) => {
    const name = request.url?.split('?')[0].slice(1)
    if (!vehicleFiles.has(name)) return next()
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
    const path = join(directory, name)
    if (!local || !existsSync(path)) {
      response.writeHead(404).end()
      return
    }
    response.setHeader('Content-Type', name.endsWith('.glb') ? 'model/gltf-binary' : 'image/webp')
    response.setHeader('Content-Length', statSync(path).size)
    response.setHeader('Cache-Control', 'private, no-cache')
    if (request.method === 'HEAD') return response.end()
    const stream = createReadStream(path)
    stream.on('error', () => response.destroy())
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  })
}

export default defineConfig({
  build: { rollupOptions: { input: { app: 'index.html', studio: 'studio-still.html' } } },
  define: { __HAS_LOCAL_VEHICLE__: JSON.stringify(existsSync(join(directory, 'vehicle.glb'))) },
  plugins: [{ name: 'local-vehicle-preview', configureServer: serveLocalVehicle, configurePreviewServer: serveLocalVehicle }],
  server: { proxy, fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local-vehicle/**', '**/*.{blend,rar}'] } },
  preview: { proxy },
})
