/* eslint-disable no-console */
import esbuild from 'esbuild';

const buildOptions = {
  minify: false,
  bundle: true,
  sourcemap: true,
  entryPoints: ['./modules/main_dev.js'],
  legalComments: 'none',
  logLevel: 'info',
  outfile: 'dist/rapid.js',
  target: 'esnext'
};

async function main() {
  const shouldWatch = process.argv.includes('--watch');

  if (shouldWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('👀  Watching for changes...');

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nStopping watch mode...');
      await ctx.dispose();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await ctx.dispose();
      process.exit(0);
    });
  } else {
    await esbuild.build(buildOptions);
  }
}

main().catch(() => process.exit(1));
