import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default defineConfig([
  ...nextVitals,
  {
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    // React Compiler is not enabled in this application. Surface its adoption
    // diagnostics without making the framework security upgrade depend on a
    // rewrite of the imperative Leaflet/canvas integration. Hook ordering and
    // dependency checks retain the Next.js defaults; these warnings remain
    // visible for an eventual compiler adoption pass.
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
]);
