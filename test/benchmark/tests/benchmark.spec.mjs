import fs from 'node:fs/promises';
import path from 'node:path';
import test from '@playwright/test';

const BASELINE_OUTPUT_PATH = path.resolve('test/benchmark/test/benchmark/perf-baseline-results.json');

function envRatio(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getSuiteCompleteHeapUsed(memoryProxy) {
  if (!memoryProxy?.supported || !Array.isArray(memoryProxy.snapshots)) return null;
  const snapshot = memoryProxy.snapshots.find(d => d?.label === 'suite_complete');
  const used = snapshot?.usedJSHeapSize;
  return Number.isFinite(used) ? used : null;
}

function enforceGuardrails(projectName, previousBaseline, currentBaseline) {
  if (!previousBaseline) {
    console.log(`PERF_GUARDRAILS_SKIPPED ${projectName} baseline missing`);
    return;
  }

  const cpuMinRatio = envRatio('RAPID_PERF_CPU_MIN_RATIO', 0.9);
  const startupMaxRatio = envRatio('RAPID_PERF_STARTUP_MAX_RATIO', 1.25);
  const longTaskCountMaxRatio = envRatio('RAPID_PERF_LONGTASK_COUNT_MAX_RATIO', 1.35);
  const longTaskTotalMaxRatio = envRatio('RAPID_PERF_LONGTASK_TOTAL_MAX_RATIO', 1.35);
  const heapUsedMaxRatio = envRatio('RAPID_PERF_HEAP_USED_MAX_RATIO', 1.25);

  const failures = [];

  const previousBenchmarks = new Map(
    (previousBaseline?.cpuProxy?.rendererBenchmarks ?? []).map(d => [d.name, d])
  );
  for (const current of (currentBaseline?.cpuProxy?.rendererBenchmarks ?? [])) {
    const previous = previousBenchmarks.get(current.name);
    if (!previous) continue;

    const prevOps = Number(previous.opsPerSec);
    const currOps = Number(current.opsPerSec);
    if (!Number.isFinite(prevOps) || !Number.isFinite(currOps) || prevOps <= 0) continue;

    const minAllowed = prevOps * cpuMinRatio;
    if (currOps < minAllowed) {
      failures.push(`${current.name}: ops/sec ${currOps} < ${minAllowed.toFixed(2)} (baseline ${prevOps}, ratio ${cpuMinRatio})`);
    }
  }

  for (const metric of ['contextInitMs', 'firstRenderMs', 'interactiveReadyMs']) {
    const prevValue = Number(previousBaseline?.startup?.[metric]);
    const currValue = Number(currentBaseline?.startup?.[metric]);
    if (!Number.isFinite(prevValue) || !Number.isFinite(currValue) || prevValue <= 0) continue;

    const maxAllowed = prevValue * startupMaxRatio;
    if (currValue > maxAllowed) {
      failures.push(`startup.${metric}: ${currValue}ms > ${maxAllowed.toFixed(2)}ms (baseline ${prevValue}ms, ratio ${startupMaxRatio})`);
    }
  }

  const prevLongTasks = previousBaseline?.cpuProxy?.longTasks;
  const currLongTasks = currentBaseline?.cpuProxy?.longTasks;
  if (prevLongTasks?.supported && currLongTasks?.supported) {
    const prevCount = Number(prevLongTasks.count);
    const currCount = Number(currLongTasks.count);
    if (Number.isFinite(prevCount) && Number.isFinite(currCount) && prevCount > 0) {
      const maxAllowedCount = prevCount * longTaskCountMaxRatio;
      if (currCount > maxAllowedCount) {
        failures.push(`longTasks.count: ${currCount} > ${maxAllowedCount.toFixed(2)} (baseline ${prevCount}, ratio ${longTaskCountMaxRatio})`);
      }
    }

    const prevTotal = Number(prevLongTasks.totalDurationMs);
    const currTotal = Number(currLongTasks.totalDurationMs);
    if (Number.isFinite(prevTotal) && Number.isFinite(currTotal) && prevTotal > 0) {
      const maxAllowedTotal = prevTotal * longTaskTotalMaxRatio;
      if (currTotal > maxAllowedTotal) {
        failures.push(`longTasks.totalDurationMs: ${currTotal} > ${maxAllowedTotal.toFixed(2)} (baseline ${prevTotal}, ratio ${longTaskTotalMaxRatio})`);
      }
    }
  }

  const prevHeapUsed = getSuiteCompleteHeapUsed(previousBaseline?.memoryProxy);
  const currHeapUsed = getSuiteCompleteHeapUsed(currentBaseline?.memoryProxy);
  if (Number.isFinite(prevHeapUsed) && Number.isFinite(currHeapUsed) && prevHeapUsed > 0) {
    const maxAllowedHeapUsed = prevHeapUsed * heapUsedMaxRatio;
    if (currHeapUsed > maxAllowedHeapUsed) {
      failures.push(`memoryProxy.suite_complete.usedJSHeapSize: ${currHeapUsed} > ${maxAllowedHeapUsed.toFixed(0)} (baseline ${prevHeapUsed}, ratio ${heapUsedMaxRatio})`);
    }
  }

  if (failures.length) {
    throw new Error(`Performance guardrail failures for ${projectName}:\n- ${failures.join('\n- ')}`);
  }

  console.log(`PERF_GUARDRAILS_PASSED ${projectName}`);
}

async function readBaselineResults() {
  let existingResults = {};
  try {
    const existingText = await fs.readFile(BASELINE_OUTPUT_PATH, 'utf8');
    existingResults = JSON.parse(existingText);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  return existingResults;
}

async function writeBaselineResult(projectName, baselineResult, existingResults) {
  existingResults[projectName] = {
    capturedAt: new Date().toISOString(),
    ...baselineResult
  };

  await fs.mkdir(path.dirname(BASELINE_OUTPUT_PATH), { recursive: true });
  await fs.writeFile(BASELINE_OUTPUT_PATH, `${JSON.stringify(existingResults, null, 2)}\n`, 'utf8');
}

test('Run benchmarks', async ({ page }, testInfo) => {
  let perfBaselineResult = null;
  const benchmarkPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };

    page.on('console', message => {
      const text = message.text();
      if (text === 'Benchmark suite complete.') {
        finish(resolve);
      } else if (text.startsWith('PERF_BASELINE_RESULT ')) {
        try {
          perfBaselineResult = JSON.parse(text.slice('PERF_BASELINE_RESULT '.length));
        } catch (error) {
          finish(reject, new Error(`Failed to parse PERF_BASELINE_RESULT output: ${error?.message || String(error)}`));
          return;
        }
        console.log(text);
      } else if (text === 'Benchmark suite failed.' || text.includes('[Execution error]') || text.includes('[Benchmark failure]') || text.includes('[Benchmark error]')) {
        finish(reject, new Error(text));
      } else if (text.includes('sampled') || text.toLowerCase().includes('benchmark')) {
        console.log(text);
      }
    });

    page.on('pageerror', error => {
      finish(reject, error);
    });
  });

  await page.goto(`http://127.0.0.1:8080/test/benchmark/bench.html`);
  await benchmarkPromise;

  if (!perfBaselineResult) {
    throw new Error('Missing PERF_BASELINE_RESULT output.');
  }

  const existingResults = await readBaselineResults();
  const previousBaseline = existingResults[testInfo.project.name];
  if (process.env.RAPID_PERF_GUARDRAILS === '1') {
    enforceGuardrails(testInfo.project.name, previousBaseline, perfBaselineResult);
  }

  await writeBaselineResult(testInfo.project.name, perfBaselineResult, existingResults);
  console.log(`PERF_BASELINE_WRITTEN ${BASELINE_OUTPUT_PATH}`);
});
