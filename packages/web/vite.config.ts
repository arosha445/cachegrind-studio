import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  // Relative asset paths so the built bundle works when dropped into
  // htdocs/cachegrind-studio/ rather than served from a domain root. That is
  // the XAMPP/WAMP install story, and absolute paths silently break it.
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
});
