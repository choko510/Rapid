import test from '@playwright/test';

test('Run benchmarks', async ({ page }) => {
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
});
