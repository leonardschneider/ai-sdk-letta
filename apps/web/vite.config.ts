import { fileURLToPath } from 'node:url';
import { defineConfig, defaultClientConditions } from 'vite';

/** Atlaskit's error reporter would send renderer errors to Atlassian's Sentry from the browser: build it out. */
const sentryStub = fileURLToPath(new URL('./stubs/sentry.ts', import.meta.url));

export default defineConfig({
  // Bundle workspace packages (ai-sdk-letta/title) from source, so the app builds without building them first.
  resolve: {
    conditions: ['ai-sdk-letta-source', ...defaultClientConditions],
    alias: [{ find: /^@sentry\/(browser|integrations)$/, replacement: sentryStub }],
  },
  // Atlaskit reads process.env.NODE_ENV (and a few other variables) at runtime.
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'), 'process.env.CLOUD_ENV': 'undefined', 'process.env': '{}' },
  build: {
    outDir: 'dist', emptyOutDir: true,
    // Fonts (KaTeX's) are always files served by the app, never data: URLs, so the CSP needs no font-src exception.
    assetsInlineLimit: (file: string) => /\.(woff2?|ttf)$/.test(file) ? false : undefined,
    // The Atlassian renderer is one lazily loaded chunk of about 1 MB gzipped (only loaded by an .adf.json preview).
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      onwarn(warning, warn) {
        // React Server Component directives are inert in this entirely client-side app.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
        // Atlaskit packages carry their own (harmless) eval and annotation warnings.
        if ((warning.code === 'EVAL' || warning.code === 'INVALID_ANNOTATION' || warning.code === 'SOURCEMAP_ERROR') && /@atlaskit|@compiled|@emotion/.test(String(warning.id ?? warning.message))) return;
        warn(warning);
      },
    },
  },
});
