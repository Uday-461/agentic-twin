import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false, // the floating dev badge sits on top of the chat input
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
