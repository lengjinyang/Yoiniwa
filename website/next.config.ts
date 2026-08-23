import type { NextConfig } from 'next';

const repository = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'Yoiniwa';
const isGitHubPages = process.env.GITHUB_ACTIONS === 'true';
const isUserSite = repository.endsWith('.github.io');
const basePath = isGitHubPages && !isUserSite ? `/${repository}` : '';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  basePath,
  assetPrefix: basePath,
  images: { unoptimized: true },
};

export default nextConfig;
