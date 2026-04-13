/* eslint-disable no-console */
import autoprefixer from 'autoprefixer';
import chalk from 'chalk';
import concat from 'concat-files';
import fs from 'node:fs';
import { glob } from 'glob';
import postcss from 'postcss';
import prepend from 'postcss-selector-prepend';

//
// This script concats all of the `/css/*` files into a single `dist/rapid.css` file.
//

let _buildPromise = null;

// If called directly, do the thing.
if (process.argv[1].indexOf('build_css.js') > -1) {
  buildCSSAsync();
}

/**
 * Get the maximum mtime from all CSS source files
 */
function getMaxSourceMtime(files) {
  let max = 0;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs > max) max = stat.mtimeMs;
    } catch {
      // If file doesn't exist, force rebuild
      return Infinity;
    }
  }
  return max;
}

/**
 * Check if CSS output is up-to-date compared to source files
 */
function isCSSUpToDate(sourceFiles, outputFile) {
  try {
    const outputStat = fs.statSync(outputFile);
    const maxSourceMtime = getMaxSourceMtime(sourceFiles);
    return outputStat.mtimeMs >= maxSourceMtime;
  } catch {
    return false;
  }
}

export function buildCSSAsync(force = false) {
  if (_buildPromise) return _buildPromise;

  const START = '🏗   ' + chalk.yellow('Building css...');
  const END = '👍  ' + chalk.green('css built');

  console.log('');
  console.log(START);
  console.time(END);

  return _buildPromise = glob('css/**/*.css')
    .then(files => {
      const sortedFiles = files.sort();

      // Skip if output is up-to-date and not forced
      if (!force && isCSSUpToDate(sortedFiles, 'dist/rapid.css')) {
        console.log(chalk.gray('↷   css is up-to-date'));
        console.timeEnd(END);
        console.log('');
        _buildPromise = null;
        return;
      }

      return concatAsync(sortedFiles, 'dist/rapid.css')
        .then(() => {
          const css = fs.readFileSync('dist/rapid.css', 'utf8');
          return postcss([ autoprefixer, prepend({ selector: '.ideditor ' }) ])
            .process(css, { from: 'dist/rapid.css', to: 'dist/rapid.css' });
        })
        .then(result => fs.writeFileSync('dist/rapid.css', result.css));
    })
    .then(() => {
      console.timeEnd(END);
      console.log('');
      _buildPromise = null;
    })
    .catch(err => {
      console.error(err);
      console.log('');
      _buildPromise = null;
      process.exit(1);
    });
}


function concatAsync(files, output) {
  return new Promise((resolve, reject) => {
    concat(files, output, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}
