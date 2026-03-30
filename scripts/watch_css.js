/* eslint-disable no-console */
import gaze from 'gaze/lib/gaze.js';

import { buildCSSAsync } from './build_css.js';


gaze(['css/**/*.css'], (err, watcher) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }

  watcher.on('all', () => buildCSSAsync());
});
