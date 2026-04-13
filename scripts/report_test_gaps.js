/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';


const FEATURE_SUBJECT_RE = /(feat:|add\b|implement\b|integration\b|sourcing\b|auto connect\b|new ways\b|overture\b)/i;
const CANDIDATE_SUBJECT_RE = /(^update$|^bug fix$|^fix\b|^perf:|^refactor\b)/i;
const SKIP_SUBJECT_RE = /(^merge pull request\b|^rapid-\d|^version bump\b|^dependency\b|^npm run (imagery|translations)\b)/i;

const args = parseArgs(process.argv.slice(2));
const oldest = args.oldest || args.from || null;
const newest = args.newest || args.to || 'HEAD';
const outputFile = args.output || null;
const includeOldest = args['include-oldest'] !== 'false';
const strictFeature = args['strict-feature'] === 'true';

if (!oldest) {
  console.error('Missing required argument: --oldest <commit>');
  printUsage();
  process.exit(1);
}

const gitRange = includeOldest ? `${oldest}^..${newest}` : `${oldest}..${newest}`;
const logLines = run(`git --no-pager log --reverse --pretty=format:%H%x09%s ${gitRange}`)
  .split(/\r?\n/)
  .filter(Boolean);

const commits = [];
for (const line of logLines) {
  const tabIndex = line.indexOf('\t');
  if (tabIndex === -1) continue;

  const hash = line.slice(0, tabIndex).trim();
  const subject = line.slice(tabIndex + 1).trim();
  const subjectClass = classifySubject(subject);
  if (subjectClass === 'skip') continue;
  if (strictFeature && subjectClass !== 'feature') continue;

  const files = run(`git --no-pager show --name-only --pretty=format: ${hash}`)
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const moduleFiles = files.filter(file => file.startsWith('modules/'));
  if (!moduleFiles.length) continue;

  const testFiles = files.filter(file => file.startsWith('test/'));
  const benchmarkFiles = files.filter(file => file.startsWith('test/benchmark/'));
  const moduleAreas = [...new Set(moduleFiles.map(file => file.split('/')[1] || 'root'))];

  commits.push({
    hash: hash,
    shortHash: hash.slice(0, 9),
    subject: subject,
    subjectClass: subjectClass,
    moduleAreas: moduleAreas,
    moduleFiles: moduleFiles,
    testFiles: testFiles,
    benchmarkFiles: benchmarkFiles,
    hasTestChanges: testFiles.length > 0,
    hasBenchmarkChanges: benchmarkFiles.length > 0
  });
}

const summary = {
  totalFeatureCommits: commits.length,
  featureClassCommits: commits.filter(c => c.subjectClass === 'feature').length,
  candidateClassCommits: commits.filter(c => c.subjectClass === 'candidate').length,
  withTestChanges: commits.filter(c => c.hasTestChanges).length,
  withoutTestChanges: commits.filter(c => !c.hasTestChanges).length,
  withBenchmarkChanges: commits.filter(c => c.hasBenchmarkChanges).length
};

const report = {
  generatedAt: new Date().toISOString(),
  range: {
    oldest: oldest,
    newest: newest,
    includeOldest: includeOldest,
    gitRange: gitRange
  },
  summary: summary,
  commits: commits
};

if (outputFile) {
  const outputPath = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

printSummary(report, outputFile);


function run(command) {
  try {
    return execSync(command, { encoding: 'utf8' });
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr) : '';
    const message = stderr || err?.message || String(err);
    console.error(message.trim());
    process.exit(1);
  }
}


function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      result[key] = 'true';
    } else {
      result[key] = next;
      i++;
    }
  }
  return result;
}


function printSummary(reportData, outputPath) {
  const { range, summary, commits: allCommits } = reportData;

  console.log(`Analyzed range: ${range.gitRange}`);
  console.log(`Feature/candidate commits with modules changes: ${summary.totalFeatureCommits}`);
  console.log(`- subject class "feature": ${summary.featureClassCommits}`);
  console.log(`- subject class "candidate": ${summary.candidateClassCommits}`);
  console.log(`- with test changes: ${summary.withTestChanges}`);
  console.log(`- without test changes: ${summary.withoutTestChanges}`);
  console.log(`- with benchmark changes: ${summary.withBenchmarkChanges}`);

  const missing = allCommits.filter(c => !c.hasTestChanges);
  if (missing.length) {
    console.log('');
    console.log('Commits lacking test changes:');
    for (const commit of missing) {
      console.log(`- ${commit.shortHash} (${commit.subjectClass}) ${commit.subject} [areas: ${commit.moduleAreas.join(', ')}]`);
    }
  }

  if (outputPath) {
    console.log('');
    console.log(`Wrote report: ${path.resolve(outputPath)}`);
  }
}


function printUsage() {
  console.log('Usage: pnpm run test:gap-report -- --oldest <commit> [--newest <ref>] [--include-oldest true|false] [--strict-feature true|false] [--output <file>]');
  console.log('Example: pnpm run test:gap-report -- --oldest 4854c7cbfec7b3e53d743b1f22531cf6d428ac9a --newest HEAD --output test-results/feature-test-gaps.json');
}


function classifySubject(subject) {
  if (SKIP_SUBJECT_RE.test(subject)) return 'skip';
  if (FEATURE_SUBJECT_RE.test(subject)) return 'feature';
  if (CANDIDATE_SUBJECT_RE.test(subject)) return 'candidate';
  return 'skip';
}
