import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // Relative paths for Tauri app loading
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssMinify: true,
    // Ensure CSS is properly extracted and not inlined
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // Ensure proper asset naming
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  esbuild: {
    // Strip console.* and debugger in production builds
    drop: process.env.NODE_ENV === 'production' ? ['console', 'debugger'] : [],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  // Optimize CSS handling
  css: {
    devSourcemap: true,
  },
});
