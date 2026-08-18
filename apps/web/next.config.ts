import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Shared workspace packages ship TypeScript source; let Next compile them.
  transpilePackages: ['@modelforge/ml'],
}

export default nextConfig
