import baseConfig from './app.json';

const isProduction = process.env.APP_ENV === 'production';

export default function createExpoConfig() {
  const plugins = (baseConfig.expo.plugins ?? []).map((plugin) => {
    if (Array.isArray(plugin) && plugin[0] === 'expo-build-properties') {
      return [
        'expo-build-properties',
        {
          android: {
            usesCleartextTraffic: !isProduction,
          },
        },
      ];
    }
    return plugin;
  });

  return {
    ...baseConfig.expo,
    plugins,
  };
}
