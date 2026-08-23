import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * The analysis pipeline reads LDraw part geometry from disk at request time,
   * so those assets must be traced into a standalone build.
   */
  outputFileTracingIncludes: {
    '/api/**': ['./public/ldraw/**/*', './data/**/*'],
  },
};

export default nextConfig;
