/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        buffer: false,
        crypto: false,
        stream: false,
        fs: false,
        path: false,
      };
      if (webpack) {
        config.plugins.push(
          new webpack.ProvidePlugin({
            Buffer: ["buffer", "Buffer"],
          })
        );
      }
    }
    return config;
  },
};

export default nextConfig;
