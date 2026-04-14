#!/usr/bin/env node

/**
 * merge_id_translations.js
 *
 * Merges translations from iD Editor (../iD) into Rapid's core locale files.
 * This is a one-time manual merge for when Transifex access is unavailable.
 *
 * What it does:
 *  1. Adds missing English source keys from iD's core.yaml to Rapid's core.yaml
 *     (only keys that Rapid's code actually references)
 *  2. For shared keys between iD and Rapid, copies translations from iD's
 *     dist/locales into Rapid's data/l10n/core.*.json where Rapid is missing them
 *  3. Creates new locale files for languages iD supports but Rapid doesn't
 *  4. Updates data/locales.json with any newly added locales
 *
 * Usage:
 *   node scripts/merge_id_translations.js [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'js-yaml';

const RAPID_ROOT = path.resolve(import.meta.dirname, '..');
const ID_ROOT = path.resolve(RAPID_ROOT, '../iD');

const DRY_RUN = process.argv.includes('--dry-run');

// Flatten a nested object into dot-separated keys
function flatten(obj, prefix = '') {
  const result = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      Object.assign(result, flatten(v, key));
    }
  } else {
    result[prefix] = obj;
  }
  return result;
}

// Unflatten dot-separated keys back into a nested object
function unflatten(flat) {
  const result = {};
  for (const [dottedKey, value] of Object.entries(flat)) {
    const parts = dottedKey.split('.');
    let node = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in node)) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }
  return result;
}

// Deep merge source into target (target wins on conflict)
function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (k in target) {
      if (typeof target[k] === 'object' && typeof v === 'object' &&
          !Array.isArray(target[k]) && !Array.isArray(v)) {
        deepMerge(target[k], v);
      }
      // target wins on leaf conflicts
    } else {
      target[k] = v;
    }
  }
  return target;
}

// Filter a nested object to only include keys (dot-paths) in the allowed set
function filterToAllowedKeys(obj, allowedKeys, prefix = '') {
  const result = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'object' && !Array.isArray(v)) {
        // Check if any allowed key starts with this prefix
        const hasAllowed = [...allowedKeys].some(ak => ak.startsWith(key + '.') || ak === key);
        if (hasAllowed) {
          const filtered = filterToAllowedKeys(v, allowedKeys, key);
          if (Object.keys(filtered).length > 0) {
            result[k] = filtered;
          }
        }
      } else {
        if (allowedKeys.has(key)) {
          result[k] = v;
        }
      }
    }
  }
  return result;
}

// Recursively sort object keys
function sortKeysDeep(obj) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const sorted = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = sortKeysDeep(obj[k]);
    }
    return sorted;
  }
  return obj;
}


console.log('=== Rapid <-- iD Translation Merge ===\n');

if (DRY_RUN) console.log('  (DRY RUN - no files will be modified)\n');

// ---------- Load English sources ----------

const idCoreYaml = YAML.load(fs.readFileSync(path.join(ID_ROOT, 'data/core.yaml'), 'utf8'));
const idEnglish = idCoreYaml.en || idCoreYaml;
const idKeys = new Set(Object.keys(flatten(idEnglish)));

const rapidCoreYaml = YAML.load(fs.readFileSync(path.join(RAPID_ROOT, 'data/core.yaml'), 'utf8'));
const rapidEnglish = rapidCoreYaml.en || rapidCoreYaml;
const rapidKeys = new Set(Object.keys(flatten(rapidEnglish)));

const sharedKeys = new Set([...idKeys].filter(k => rapidKeys.has(k)));
const idOnlyKeys = new Set([...idKeys].filter(k => !rapidKeys.has(k)));

console.log(`  iD English keys:    ${idKeys.size}`);
console.log(`  Rapid English keys: ${rapidKeys.size}`);
console.log(`  Shared keys:        ${sharedKeys.size}`);
console.log(`  iD-only keys:       ${idOnlyKeys.size}\n`);

// ---------- Step 1: Add missing English keys that Rapid code references ----------

// These 9 keys are referenced in Rapid's source but missing from core.yaml
const missingReferencedKeys = [
  'background.key',
  'help.key',
  'inspector.edit',
  'issues.invalid_format.email.message',
  'issues.invalid_format.website.message',
  'issues.invalid_format.website.reference',
  'issues.key',
  'map_data.key',
  'preferences.key',
];

const idFlat = flatten(idEnglish);
const keysToAddToEnglish = {};
for (const key of missingReferencedKeys) {
  if (idFlat[key] && !rapidKeys.has(key)) {
    keysToAddToEnglish[key] = idFlat[key];
  }
}

if (Object.keys(keysToAddToEnglish).length > 0) {
  console.log(`Step 1: Adding ${Object.keys(keysToAddToEnglish).length} missing English keys to core.yaml`);
  for (const [k, v] of Object.entries(keysToAddToEnglish)) {
    console.log(`  + ${k} = "${v}"`);
  }

  if (!DRY_RUN) {
    // Read core.yaml as text and append new keys into the right sections
    const yamlContent = fs.readFileSync(path.join(RAPID_ROOT, 'data/core.yaml'), 'utf8');
    const parsed = YAML.load(yamlContent);
    const root = parsed.en || parsed;

    // Merge in the new keys
    const newNested = unflatten(keysToAddToEnglish);
    deepMerge(root, newNested);

    // Write back
    const outYaml = YAML.dump({ en: root }, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: true,
      quotingType: '"',
      forceQuotes: true,
    });
    fs.writeFileSync(path.join(RAPID_ROOT, 'data/core.yaml'), outYaml);
    console.log('  -> core.yaml updated\n');
  }
} else {
  console.log('Step 1: No missing referenced English keys to add\n');
}

// ---------- Step 2: Merge translations for shared keys ----------

const idLocaleDir = path.join(ID_ROOT, 'dist/locales');
const rapidLocaleDir = path.join(RAPID_ROOT, 'data/l10n');

// Get existing Rapid locales
const rapidLocaleFiles = fs.readdirSync(rapidLocaleDir)
  .filter(f => f.startsWith('core.') && f.endsWith('.json') && f !== 'core.en.json');
const rapidLocales = new Set(rapidLocaleFiles.map(f => f.replace('core.', '').replace('.json', '')));

// Get iD locales
const idLocaleFiles = fs.readdirSync(idLocaleDir)
  .filter(f => f.endsWith('.min.json') && f !== 'index.min.json');
const idLocales = new Set(idLocaleFiles.map(f => f.replace('.min.json', '')));

// All keys we allow (Rapid's English source keys)
const allowedKeys = rapidKeys;
// Also add the newly added keys
for (const k of Object.keys(keysToAddToEnglish)) {
  allowedKeys.add(k);
}

let totalNewTranslations = 0;
let localesUpdated = 0;
let localesCreated = 0;

console.log('Step 2: Merging translations for shared keys...');

for (const locale of [...idLocales].sort()) {
  if (locale === 'en' || locale === 'en-US') continue;

  const idFile = path.join(idLocaleDir, `${locale}.min.json`);
  const idData = JSON.parse(fs.readFileSync(idFile, 'utf8'));
  const idLocKey = Object.keys(idData)[0];
  if (!idLocKey) continue;
  const idFlat = flatten(idData[idLocKey]);

  // Filter to only allowed (Rapid) keys
  const filteredIdTranslations = {};
  for (const [k, v] of Object.entries(idFlat)) {
    if (allowedKeys.has(k)) {
      filteredIdTranslations[k] = v;
    }
  }

  if (Object.keys(filteredIdTranslations).length === 0) continue;

  const rapidFile = path.join(rapidLocaleDir, `core.${locale}.json`);
  const isExisting = rapidLocales.has(locale);

  let rapidFlat = {};
  if (isExisting) {
    const rapidData = JSON.parse(fs.readFileSync(rapidFile, 'utf8'));
    const rLocKey = Object.keys(rapidData)[0];
    if (rLocKey) {
      rapidFlat = flatten(rapidData[rLocKey]);
    }
  }

  // Find translations iD has that Rapid doesn't
  let newCount = 0;
  const merged = { ...rapidFlat };
  for (const [k, v] of Object.entries(filteredIdTranslations)) {
    if (!(k in merged)) {
      merged[k] = v;
      newCount++;
    }
  }

  if (newCount === 0) continue;

  totalNewTranslations += newCount;

  if (isExisting) {
    localesUpdated++;
  } else {
    localesCreated++;
  }

  const label = isExisting ? 'updated' : 'NEW';
  if (newCount > 50 || !isExisting) {
    console.log(`  ${locale}: +${newCount} translations (${label})`);
  }

  if (!DRY_RUN) {
    // Build output by deep-merging iD's nested data into Rapid's nested data
    // This avoids flatten/unflatten conflicts with plural forms
    let rapidNested = {};
    if (isExisting) {
      const rapidData = JSON.parse(fs.readFileSync(rapidFile, 'utf8'));
      const rLocKey = Object.keys(rapidData)[0];
      if (rLocKey) rapidNested = rapidData[rLocKey];
    }

    // Filter iD's nested data to only allowed keys, then deep merge
    const idNested = idData[idLocKey];
    const filtered = filterToAllowedKeys(idNested, allowedKeys);
    deepMerge(rapidNested, filtered);

    const output = JSON.stringify({ [locale]: sortKeysDeep(rapidNested) }, null, 2) + '\n';
    fs.writeFileSync(rapidFile, output);
  }
}

console.log(`\n  Total new translations added: ${totalNewTranslations}`);
console.log(`  Existing locales updated: ${localesUpdated}`);
console.log(`  New locale files created: ${localesCreated}\n`);

// ---------- Step 3: Update locales.json with new locales ----------

if (localesCreated > 0) {
  console.log('Step 3: Updating data/locales.json with new locales...');

  const localesJsonPath = path.join(RAPID_ROOT, 'data/locales.json');
  const localesJsonWrapper = JSON.parse(fs.readFileSync(localesJsonPath, 'utf8'));
  const localesJson = localesJsonWrapper.locales || localesJsonWrapper;

  // RTL locales (known)
  const rtlCodes = new Set(['ar', 'ar-AA', 'ckb', 'dv', 'fa', 'fa-IR', 'he', 'he-IL', 'pa-PK', 'ur', 'ps', 'yi']);

  for (const locale of [...idLocales].sort()) {
    if (locale === 'en' || locale === 'en-US' || locale === 'index') continue;
    if (localesJson[locale]) continue;

    // Check if we created a file for this locale
    const rapidFile = path.join(rapidLocaleDir, `core.${locale}.json`);
    if (!fs.existsSync(rapidFile) && DRY_RUN) {
      // In dry run, check if we would have created it
      const idFile = path.join(idLocaleDir, `${locale}.min.json`);
      const idData = JSON.parse(fs.readFileSync(idFile, 'utf8'));
      const idLocKey = Object.keys(idData)[0];
      if (!idLocKey) continue;
      const idFlat = flatten(idData[idLocKey]);
      const hasKeys = Object.keys(idFlat).some(k => allowedKeys.has(k));
      if (!hasKeys) continue;
    } else if (!fs.existsSync(rapidFile)) {
      continue;
    }

    localesJson[locale] = { rtl: rtlCodes.has(locale) };
    console.log(`  + ${locale} (rtl: ${rtlCodes.has(locale)})`);
  }

  if (!DRY_RUN) {
    // Sort locales.json by key
    const sorted = {};
    for (const k of Object.keys(localesJson).sort()) {
      sorted[k] = localesJson[k];
    }
    // Preserve the wrapper structure
    const output = localesJsonWrapper.locales ? { locales: sorted } : sorted;
    fs.writeFileSync(localesJsonPath, JSON.stringify(output, null, 2) + '\n');
    console.log('  -> locales.json updated\n');
  }
} else {
  console.log('Step 3: No new locales to add to locales.json\n');
}

console.log('=== Done ===');
if (DRY_RUN) {
  console.log('\nRe-run without --dry-run to apply changes.');
}
