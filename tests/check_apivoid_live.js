// Live diagnostic against APIVoid's bot-detection test page: load the
// extension, collect what the page's BotDetector gathers, submit it to
// /fp-test/js-check/ and dump the verdict. Launch/retry/cleanup/report
// plumbing all comes from the shared harness in ./lib/live_harness.
const h = require('./lib/live_harness');

h.runWithRetry('apivoid-check', { headed: process.env.HEADED === '1' }, async (ctx) => {
  const cdp = ctx.cdp;

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log('Navigating to APIVoid test page...');
  await cdp.send('Page.navigate', { url: 'https://www.apivoid.com/tools/bot-detection-test/' });
  await h.sleep(5000);

  // Bare-browser guard: if the extension engine never injected, fail loudly
  // (runWithRetry retries once with a fresh profile) instead of reporting
  // fake results from an unprotected page.
  await h.ensureEngine(ctx.cdp);

  // Site precondition: this script probes the page's BotDetector API. APIVoid
  // redesigned the bot-detection-test page (2026-10) and window.BotDetector is
  // gone; every downstream probe would emit meaningless undefined fields.
  // Fail loudly instead — rewrite the probes against the new page flow (or
  // drop this script from the live chain) to bring it back to life.
  const pre = await cdp.send('Runtime.evaluate', {
    expression: `typeof window.BotDetector !== 'undefined' && typeof window.BotDetector.collect === 'function'`,
    returnByValue: true
  });
  if (!pre.result?.value) {
    console.log('!!!!! SITE PRECONDITION FAILED: window.BotDetector is gone from the page.');
    console.log('!!!!! APIVoid redesigned the bot-detection-test page; these probes target a dead API.');
    console.log('!!!!! Rewrite against the new page flow, or remove this script from the live chain.');
    h.saveReport('apivoid-check', {
      name: 'apivoid-check',
      timestamp: new Date().toISOString(),
      url: 'https://www.apivoid.com/tools/bot-detection-test/',
      sitePrecondition: 'BotDetector missing — page redesigned, probes not run'
    });
    process.exitCode = 1;
    return;
  }

  // Collect payload and check what BotDetector.collect() gathered
  const payloadRes = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
        if (!window.BotDetector || !window.BotDetector.collect) {
          return { error: 'BotDetector not found' };
        }
        const p = await window.BotDetector.collect(); p.remoteDebugger = { attached: false, method: "" };
        return p;
      })()`,
    awaitPromise: true,
    returnByValue: true
  });

  const collected = payloadRes.result.value;
  console.log('Collected worker data intl:', collected.worker?.data?.intl);
  console.log('Collected worker data highEntropy:', collected.worker?.data?.highEntropy);
  console.log('Collected iframe:', JSON.stringify(collected.iframe, null, 2));

  // Now submit to js-check
  console.log('Submitting to /fp-test/js-check/ ...');
  const checkRes = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
        const checkUrl = String.fromCharCode(47,102,112,45,116,101,115,116,47,106,115,45,99,104,101,99,107,47);
        const p = await window.BotDetector.collect();
        const r = await fetch(checkUrl, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(p)
        });
        return await r.text();
      })()`,
    awaitPromise: true,
    returnByValue: true
  });

  console.log('Check result raw:', checkRes.result?.value);
  let parsedData = null;
  let parseError = null;
  try {
    const data = JSON.parse(checkRes.result?.value || '{}');
    parsedData = data;
    console.log('Parsed verdict:', JSON.stringify(data.verdict, null, 2));
    console.log('Parsed groups:', JSON.stringify(data.groups, null, 2));
    console.log('Parsed derived:', JSON.stringify(data.derived, null, 2));
  } catch (e) {
    parseError = String(e);
    console.error('Parse error:', e);
  }

  const report = {
    name: 'apivoid-check',
    timestamp: new Date().toISOString(),
    url: 'https://www.apivoid.com/tools/bot-detection-test/',
    payloadSummary: {
      workerIntl: collected.worker?.data?.intl,
      workerHighEntropy: collected.worker?.data?.highEntropy,
      iframe: collected.iframe
    },
    jsCheckRaw: checkRes.result?.value ?? null,
    jsCheck: parsedData ? {
      verdict: parsedData.verdict,
      groups: parsedData.groups,
      derived: parsedData.derived
    } : null,
    parseError
  };
  const reportPath = await h.saveReport('apivoid-check', report);
  console.log('Report saved to:', reportPath);
}).catch(err => {
  console.error('apivoid-check failed:', err);
  process.exitCode = 1;
});
