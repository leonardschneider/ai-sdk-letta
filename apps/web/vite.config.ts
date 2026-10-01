import { defineConfig, defaultClientConditions } from 'vite';

export default defineConfig({
  // Bundle workspace packages (ai-sdk-letta/title) from source, so the app builds without building them first.
  resolve: { conditions: ['ai-sdk-letta-source', ...defaultClientConditions] },
  build: {
    outDir: 'dist', emptyOutDir: true,
    // Fonts (KaTeX's) are always files served by the app, never data: URLs, so the CSP needs no font-src exception.
    assetsInlineLimit: (file: string) => /\.(woff2?|ttf)$/.test(file) ? false : undefined,
    rollupOptions: {
      onwarn(warning, warn) {
        // React Server Component directives are inert in this entirely client-side app.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
        warn(warning);
      },
    },
  },
});
