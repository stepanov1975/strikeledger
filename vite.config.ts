import { defineConfig, type Plugin } from 'vite';
import { devvit } from '@devvit/start/vite';

type DevvitEnvironmentConfig = {
  build?: {
    rollupOptions?: { output?: unknown };
    rolldownOptions?: { output?: unknown };
  };
};

const getOutputOptions = (
  environment: DevvitEnvironmentConfig | undefined
): Record<string, unknown> | null => {
  const output =
    environment?.build?.rollupOptions?.output ??
    environment?.build?.rolldownOptions?.output;
  return output && typeof output === 'object' && !Array.isArray(output)
    ? (output as Record<string, unknown>)
    : null;
};

const devvitViteCompat = (): Plugin => ({
  name: 'devvit-vite-compat',
  configResolved(config) {
    const environments = config.environments as Record<
      string,
      DevvitEnvironmentConfig
    >;
    const clientOutput = getOutputOptions(environments.client);
    if (clientOutput) {
      delete clientOutput.sourcemapFileNames;
    }

    const serverOutput = getOutputOptions(environments.server);
    if (serverOutput) {
      delete serverOutput.inlineDynamicImports;
      serverOutput.codeSplitting = false;
    }
  },
});

export default defineConfig({
  plugins: [devvit(), devvitViteCompat()],
});
