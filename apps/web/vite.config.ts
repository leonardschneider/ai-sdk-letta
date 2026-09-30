import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist', emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        // React Server Component directives are inert in this entirely client-side app.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
        warn(warning);
      },
    },
  },
});
