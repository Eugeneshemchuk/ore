import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/ore/',
  plugins: [react()],
  build: {
    // three.js changes far less often than the scene, so keep it in its own
    // long-cached chunk; it alone exceeds the default 500 kB warning.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: (id) => id.includes('node_modules/three/') ? 'three' : id.includes('node_modules') ? 'vendor' : undefined,
      },
    },
  },
})
