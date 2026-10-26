import type { NextConfig } from 'next';
const config: NextConfig = { output: 'standalone', serverExternalPackages: ['pg'], experimental: { cpus: 2 } };
export default config;
