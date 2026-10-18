const h = require('./lib/live_harness');

h.runWithRetry('apivoid-diagnose', { headed: process.env.HEADED === '1' }, async (ctx) => {
    const cdp = ctx.cdp;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.navigate', { url: 'https://www.apivoid.com/tools/bot-detection-test/' });
    await h.sleep(4000);

    // Bare-browser guard: the extension engine must be present before probing.
    await h.ensureEngine(ctx.cdp);

    // Site precondition: the probes below mutate window.BotDetector payloads.
    // APIVoid redesigned the bot-detection-test page (2026-10) and
    // window.BotDetector is gone; base-payload collection would return
    // garbage and every mutation probe would cascade undefined results.
    // Fail loudly instead — rewrite against the new page flow (or drop this
    // script from the live chain) to bring it back to life.
    const pre = await cdp.send('Runtime.evaluate', {
      expression: `typeof window.BotDetector !== 'undefined' && typeof window.BotDetector.collect === 'function'`,
      returnByValue: true
    });
    if (!pre.result?.value) {
      console.log('!!!!! SITE PRECONDITION FAILED: window.BotDetector is gone from the page.');
      console.log('!!!!! APIVoid redesigned the bot-detection-test page; these probes target a dead API.');
      console.log('!!!!! Rewrite against the new page flow, or remove this script from the live chain.');
      h.saveReport('apivoid-diagnose', {
        name: 'apivoid-diagnose',
        timestamp: new Date().toISOString(),
        target: 'https://www.apivoid.com/tools/bot-detection-test/',
        sitePrecondition: 'BotDetector missing — page redesigned, probes not run'
      });
      process.exitCode = 1;
      return;
    }

    // Grab base payload
    const basePayloadRes = await cdp.send('Runtime.evaluate', {
      expression: `(async () => JSON.stringify(await window.BotDetector.collect()))()`,
      awaitPromise: true,
      returnByValue: true
    });
    const basePayload = JSON.parse(basePayloadRes.result.value);

    async function probe(label, mutator) {
      const p = JSON.parse(JSON.stringify(basePayload));
      mutator(p);
      console.log("Calling evaluate..."); const res = await cdp.send('Runtime.evaluate', {
        expression: `(async () => {
          const checkUrl = String.fromCharCode(47,102,112,45,116,101,115,116,47,106,115,45,99,104,101,99,107,47);
          const raw = atob(${JSON.stringify(Buffer.from(JSON.stringify(p)).toString('base64'))});
          const r = await fetch(checkUrl, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: raw
          });
          return await r.text();
        })()`,
        awaitPromise: true,
        returnByValue: true
      });
      console.log("res:", res); if (!res.result?.value || res.result.value.startsWith('ERR')) {
        console.log(`[${label.padEnd(30)}] Error:`, res.result?.value);
      }
      let data = {};
      try { data = JSON.parse(res.result?.value || '{}'); } catch (e) {
        console.log(`[${label.padEnd(30)}] JSON parse error:`, res.result?.value);
      }
      const v = data.verdict || {};
      const d = data.derived || {};
      const g = (data.groups || []).map(x => `${x.id}:${x.status}(${x.ruleCount})`).join(' ');
      console.log(`[${label.padEnd(30)}] score=${v.score} | tampered=${v.tampered} (signals: ${v.tamperSignals}) | rules=${v.ruleCount} | inferredBrowser=${d.inferredBrowser} | ${g}`);
      await h.sleep(1000);
      return data;
    }

    console.log('--- Probing APIVoid Heuristics ---');
    const probes = {};
    probes['0. BASE PAYLOAD'] = await probe('0. BASE PAYLOAD', p => {});

    probes['1. Fix Worker Intl Timezone'] = await probe('1. Fix Worker Intl Timezone', p => {
      if (p.worker?.data?.intl) {
        p.worker.data.intl.offsetNow = 420;
        p.worker.data.intl.offsetJan = 480;
        p.worker.data.intl.offsetJul = 420;
        p.worker.data.intl.dateString = "Sun Sep 13 2020 05:26:40 GMT-0700 (Pacific Daylight Time)";
      }
    });

    probes['2. Fix Worker HighEntropy'] = await probe('2. Fix Worker HighEntropy', p => {
      if (p.worker?.data?.highEntropy) {
        p.worker.data.highEntropy.fullVersionList = "Google Chrome 153.0.0.0, Chromium 153.0.0.0, Not_A Brand 8.0.0.0";
      }
    });

    probes['3. Fix ClientHints FullVerList'] = await probe('3. Fix ClientHints FullVerList', p => {
      if (p.clientHints?.fullVersionList) {
        p.clientHints.fullVersionList = [
          { brand: 'Google Chrome', version: '153.0.0.0' },
          { brand: 'Chromium', version: '153.0.0.0' },
          { brand: 'Not_A Brand', version: '8.0.0.0' }
        ];
        p.clientHints.fullVersionListDisplay = 'Google Chrome 153.0.0.0, Chromium 153.0.0.0, Not_A Brand 8.0.0.0';
      }
    });

    probes['4. Fix 1 + 2 + 3 combined'] = await probe('4. Fix 1 + 2 + 3 combined', p => {
      if (p.worker?.data?.intl) {
        p.worker.data.intl.offsetNow = 420;
        p.worker.data.intl.offsetJan = 480;
        p.worker.data.intl.offsetJul = 420;
        p.worker.data.intl.dateString = "Sun Sep 13 2020 05:26:40 GMT-0700 (Pacific Daylight Time)";
      }
      if (p.worker?.data?.highEntropy) {
        p.worker.data.highEntropy.fullVersionList = "Google Chrome 153.0.0.0, Chromium 153.0.0.0, Not_A Brand 8.0.0.0";
      }
      if (p.clientHints?.fullVersionList) {
        p.clientHints.fullVersionList = [
          { brand: 'Google Chrome', version: '153.0.0.0' },
          { brand: 'Chromium', version: '153.0.0.0' },
          { brand: 'Not_A Brand', version: '8.0.0.0' }
        ];
        p.clientHints.fullVersionListDisplay = 'Google Chrome 153.0.0.0, Chromium 153.0.0.0, Not_A Brand 8.0.0.0';
      }
    });

    const report = {
      target: 'https://www.apivoid.com/tools/bot-detection-test/',
      headed: ctx.headed,
      basePayload,
      probes
    };
    const reportPath = await h.saveReport('apivoid-diagnose', report);
    console.log('Report saved to:', reportPath);
}).catch(console.error);
