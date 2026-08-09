import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/target/**'] },
  },
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-runtime',
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
          ],
        },
      },
    },
  },
});
