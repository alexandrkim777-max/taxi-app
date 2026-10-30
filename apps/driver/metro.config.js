// - Lets the app import the shared package (rating tags) from the monorepo.
// - Real builds replace the demo mock with an empty stub, so demo data never ships.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../../packages/shared')];
// Shared files live outside the app: their imports (and Babel helpers) resolve from the app's node_modules.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];

const demo = process.env.EXPO_PUBLIC_DEMO === '1';
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (!demo && moduleName === './mock' && context.originModulePath.endsWith(path.join('src', 'api.ts'))) {
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'src/mock.prod.ts') };
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};
module.exports = config;
