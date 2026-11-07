import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { productionEnvGuard } from './scripts/production-env-guard.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [productionEnvGuard(), react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
