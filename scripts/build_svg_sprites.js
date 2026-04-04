/* eslint-disable no-console */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { globSync } from 'glob';
import shell from 'shelljs';

const cacheFile = 'dist/img/.spritecache';
const START = '🏗   Building sprites...';
const END = '👍  sprites built';

const SPRITES = [
  {
    name: 'community',
    output: 'dist/img/community-sprite.svg',
    inputs: ['node_modules/osm-community-index/dist/img/*.svg'],
    cmd: 'svg-sprite --symbol --symbol-dest . --shape-id-generator "community-%s" --symbol-sprite dist/img/community-sprite.svg node_modules/osm-community-index/dist/img/*.svg'
  },
  {
    name: 'fa',
    output: 'dist/img/fa-sprite.svg',
    inputs: ['svg/fontawesome/*.svg'],
    cmd: 'svg-sprite --symbol --symbol-dest . --symbol-sprite dist/img/fa-sprite.svg svg/fontawesome/*.svg'
  },
  {
    name: 'maki',
    output: 'dist/img/maki-sprite.svg',
    inputs: ['node_modules/@mapbox/maki/icons/*.svg'],
    cmd: 'svg-sprite --symbol --symbol-dest . --shape-id-generator "maki-%s" --symbol-sprite dist/img/maki-sprite.svg node_modules/@mapbox/maki/icons/*.svg'
  },
  {
    name: 'mapillary:signs',
    output: 'dist/img/mapillary-sprite.svg',
    inputs: ['node_modules/@rapideditor/mapillary_sprite_source/package_signs/*.svg'],
    cmd: 'svg-sprite --symbol --symbol-dest . --symbol-sprite dist/img/mapillary-sprite.svg node_modules/@rapideditor/mapillary_sprite_source/package_signs/*.svg'
  },
  {
    name: 'mapillary:objects',
    output: 'dist/img/mapillary-object-sprite.svg',
    inputs: ['node_modules/@rapideditor/mapillary_sprite_source/package_objects/*.svg'],
    cmd: 'svg-sprite --symbol --symbol-dest . --symbol-sprite dist/img/mapillary-object-sprite.svg node_modules/@rapideditor/mapillary_sprite_source/package_objects/*.svg'
  },
  {
    name: 'rapid',
    output: 'dist/img/rapid-sprite.svg',
    inputs: ['svg/rapid-sprite/**/*.svg'],
    cmd: 'svg-sprite --symbol --symbol-dest . --shape-id-generator "rapid-%s" --symbol-sprite dist/img/rapid-sprite.svg "svg/rapid-sprite/**/*.svg"'
  },
  {
    name: 'roentgen',
    output: 'dist/img/roentgen-sprite.svg',
    inputs: ['svg/roentgen/*.svg'],
    cmd: 'svg-sprite --symbol --symbol-dest . --shape-id-generator "roentgen-%s" --symbol-sprite dist/img/roentgen-sprite.svg svg/roentgen/*.svg'
  },
  {
    name: 'temaki',
    output: 'dist/img/temaki-sprite.svg',
    inputs: ['node_modules/@rapideditor/temaki/icons/*.svg'],
    cmd: 'svg-sprite --symbol --symbol-dest . --shape-id-generator "temaki-%s" --symbol-sprite dist/img/temaki-sprite.svg node_modules/@rapideditor/temaki/icons/*.svg'
  }
];

console.log('');
console.log(START);
console.time(END);

shell.mkdir('-p', 'dist/img');

const prevCache = readCache();
const nextCache = {};

for (const sprite of SPRITES) {
  const signature = getSignature(sprite.inputs);
  const unchanged = prevCache[sprite.name] === signature && shell.test('-f', sprite.output);

  if (unchanged) {
    console.log(`↷   ${sprite.name} sprite cache hit`);
    nextCache[sprite.name] = signature;
    continue;
  }

  const runResult = shell.exec(sprite.cmd, { silent: true });
  if (runResult.code !== 0) {
    process.stdout.write(runResult.stdout);
    process.stderr.write(runResult.stderr);
    process.exit(runResult.code);
  }

  console.log(`✓   ${sprite.name} sprite rebuilt`);
  nextCache[sprite.name] = signature;
}

fs.writeFileSync(cacheFile, JSON.stringify(nextCache, null, 2) + '\n');
console.timeEnd(END);
console.log('');


function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return {};
  }
}


function getSignature(globs) {
  const files = [];
  for (const pattern of globs) {
    files.push(...globSync(pattern).sort());
  }

  const rows = [];
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');
    try {
      const stat = fs.statSync(file);
      rows.push(`${normalized}:${stat.size}:${Math.round(stat.mtimeMs)}`);
    } catch {
      rows.push(`${normalized}:missing`);
    }
  }

  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}
