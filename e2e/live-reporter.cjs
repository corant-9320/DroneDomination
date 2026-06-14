/**
 * Minimal live Playwright reporter — prints FULL, untruncated test titles as
 * each test starts and finishes. The built-in `list`/`line` reporters fit
 * titles to the console width and prepend "…", which hides the test name.
 *
 * Use with: --reporter=./e2e/live-reporter.cjs
 */
class LiveReporter {
  onBegin(_config, suite) {
    this.total = suite.allTests().length;
    this.done = 0;
    console.log(`\nRunning ${this.total} tests\n`);
  }

  onTestBegin(test) {
    const title = test.titlePath().filter(Boolean).join(' › ');
    console.log(`▶  START          ${title}`);
  }

  onTestEnd(test, result) {
    this.done++;
    const title = test.titlePath().filter(Boolean).join(' › ');
    const n = String(this.done).padStart(2, ' ');
    const secs = (result.duration / 1000).toFixed(1);
    let mark;
    if (result.status === 'passed') mark = '✓ PASS';
    else if (result.status === 'skipped') mark = '⊘ SKIP';
    else mark = `✗ ${result.status.toUpperCase()}`;
    console.log(`${mark}  ${n}/${this.total}  (${secs}s)  ${title}`);
    if (result.status !== 'passed' && result.status !== 'skipped' && result.error) {
      console.log(`        ${(result.error.message || '').split('\n')[0]}`);
    }
  }

  onEnd(result) {
    console.log(`\nFinished — status: ${result.status}\n`);
  }
}

module.exports = LiveReporter;
