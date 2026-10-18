// Forged-payload differential experiment against APIVoid's bot-detection
// test page (2026-10 redesign): load the extension, grab the page's
// BotDetector v2 payload, mutate one cross-realm signal at a time (worker
// Intl timezone, worker HighEntropy brand string, main-realm ClientHints
// fullVersionList, then all combined) and re-submit to /fp-test/js-check/
// to observe how score / tamperSignals react. The page's nginx now 403s
// User-Agents containing "HeadlessChrome", so we present the browser's
// true identity with only the headless token stripped (see header comment
// in check_apivoid_live.js for the full investigation notes, including the
// observed 68/83 verdict flakiness from per-session canvas randomization).
const h = require('./lib/live_harness');

// Present the browser's true identity with only the "HeadlessChrome" token
// stripped, so nginx serves the tool page instead of its 403 gate.
// navigator.userAgentData is not exposed on about:blank (verified on
// Chromium 155), so the native UA/CH identity is harvested from the wire:
// a probe navigation to the tool page (it 403s, but the request headers are
// what we need) yields the real User-Agent + sec-ch-ua headers, which are
// then re-sent via Network.setUserAgentOverride minus the headless token.
// High-entropy values that the wire does not carry are derived from the
// host (kernel version, arch) the same way a native Linux Chrome reports
// them. Everything is read at runtime so this stays correct for whatever
// Chromium CHROME_BIN points at.
async function applyNonHeadlessUA(cdp) {
    const hdr = (headers, name) => {
        if (!headers) return '';
        const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
        return key ? String(headers[key]) : '';
    };
    let native = null;
    const grab = (headers) => {
        if (native || !headers) return;
        const ua = hdr(headers, 'User-Agent');
        if (!ua || !/Chrome\/[\d.]+/.test(ua)) return;
        native = { ua, ch: hdr(headers, 'sec-ch-ua'), chPlatform: hdr(headers, 'sec-ch-ua-platform') };
    };
    cdp.on('Network.requestWillBeSent', (p) => grab(p && p.request && p.request.headers));
    cdp.on('Network.requestWillBeSentExtraHeaders', (p) => grab(p && p.headers));

    // Probe navigation: harvest the native request headers (the response may
    // well be the 403 gate — irrelevant, we only read what was sent).
    await cdp.send('Page.navigate', { url: 'https://www.apivoid.com/tools/bot-detection-test/' });
    await h.sleep(2500);

    const ua = String((native && native.ua) || '').replace('HeadlessChrome/', 'Chrome/');
    if (!ua) {
        console.log('!!!!! Could not harvest native request headers; skipping UA override.');
        return null;
    }
    const match = /Chrome\/([\d.]+)/.exec(ua);
    const fullVer = match ? match[1] : '155.0.0.0';
    const major = fullVer.split('.')[0];
    const fixBrand = (b) => (b === 'HeadlessChrome' ? 'Chromium' : b);
    const padVer = (v) => v.split('.').concat(['0', '0', '0']).slice(0, 4).join('.');
    // Brands from the native sec-ch-ua header ("X";v="N", ...), deduped, with
    // the headless brand folded into Chromium.
    const brands = [];
    const seen = new Set();
    const header = (native && native.ch) || '';
    for (const m of header.matchAll(/"([^"]+)";v="([^"]*)"/g)) {
        const brand = fixBrand(m[1]);
        if (!brand || seen.has(brand)) continue;
        seen.add(brand);
        brands.push({ brand, version: m[2] || major });
    }
    if (!brands.length) brands.push({ brand: 'Chromium', version: major }, { brand: 'Not(A:Brand', version: '24' });
    const fullVersionList = brands.map(b => ({ brand: b.brand, version: padVer(b.version) }));
    const platform = ((native && native.chPlatform) || '').replace(/"/g, '') || 'Linux';
    // Native Linux Chrome reports the numeric kernel version (distro
    // suffixes like Arch's "-arch1-1" stripped). The site's heuristics
    // currently flag kernels newer than 6.x as implausible (verified live:
    // true kernel 7.2.10 -> +1 integrity rule and a tamper signal; 6.12.0
    // -> clean), so clamp anything newer to a mainstream LTS kernel. The
    // clamp only shapes what the HARNESS presents — the extension under
    // test does not patch userAgentData (iframe probe: patchedMethods is
    // empty), so this keeps a host-specific false positive out of the
    // baseline measurement.
    const kernel = require('os').release().split(/[.-]/).filter(c => /^\d+$/.test(c));
    const kernelMajor = parseInt(kernel[0], 10) || 0;
    const platformVersion = kernelMajor > 6 ? '6.12.0' : kernel.slice(0, 3).join('.');
    await cdp.send('Network.setUserAgentOverride', {
        userAgent: ua,
        userAgentMetadata: {
            brands,
            fullVersionList,
            fullVersion: fullVer,
            platform,
            platformVersion,
            architecture: process.arch === 'arm64' ? 'arm' : 'x86',
            model: '',
            mobile: false,
            bitness: process.arch.endsWith('64') ? '64' : '32',
            wow64: false
        }
    });
    return ua;
}

h.runWithRetry('apivoid-diagnose', { headed: process.env.HEADED === '1' }, async (ctx) => {
    const cdp = ctx.cdp;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    const ua = await applyNonHeadlessUA(cdp);
    if (ua) console.log('Presenting non-headless UA:', ua);

    await cdp.send('Page.navigate', { url: 'https://www.apivoid.com/tools/bot-detection-test/' });
    await h.sleep(4000);

    // Bare-browser guard: the extension engine must be present before probing.
    await h.ensureEngine(ctx.cdp);

    // Site precondition: the probes below mutate window.BotDetector payloads.
    // The 2026-10 redesign ships BotDetector v2 (collect + check, auto-runs
    // on load). If collect() is missing, the page changed again — or nginx
    // served its 403 gate because the UA override above failed — so fail
    // loudly instead of cascading undefined results.
    const pre = await cdp.send('Runtime.evaluate', {
        expression: `(() => ({
        collectFn: typeof window.BotDetector !== 'undefined' && typeof window.BotDetector.collect === 'function',
        title: document.title
      }))()`,
        returnByValue: true
    });
    const preInfo = (pre.result && pre.result.value) || {};
    if (!preInfo.collectFn) {
        console.log('!!!!! SITE PRECONDITION FAILED: window.BotDetector.collect is unavailable.');
        console.log(`!!!!! Page title: "${preInfo.title}"`);
        console.log('!!!!! Either the page changed again, or nginx served its HeadlessChrome 403 gate.');
        h.saveReport('apivoid-diagnose', {
            name: 'apivoid-diagnose',
            timestamp: new Date().toISOString(),
            target: 'https://www.apivoid.com/tools/bot-detection-test/',
            sitePrecondition: `BotDetector.collect missing — page title: ${preInfo.title}`
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

    // A coherent branded-Chrome brand story for probes 2-4 (the old
    // hardcoded Chrome 153 set, refreshed to this browser's generation so
    // the forgery stays internally consistent with the real version).
    const fvl = (basePayload.clientHints && basePayload.clientHints.fullVersionList) || [];
    const chromeEntry = fvl.find(b => b.brand === 'Chromium') || fvl[0] || null;
    const chromeVer = (chromeEntry && chromeEntry.version) || '155.0.0.0';
    const greaseEntry = fvl.find(b => b.brand !== 'Chromium' && b.brand !== 'Google Chrome') || null;
    const greaseBrand = (greaseEntry && greaseEntry.brand) || 'Not(A:Brand';
    const greaseVer = (greaseEntry && greaseEntry.version) || '24.0.0.0';
    const brandedDisplay = `Google Chrome ${chromeVer}, Chromium ${chromeVer}, ${greaseBrand} ${greaseVer}`;

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
            p.worker.data.highEntropy.fullVersionList = brandedDisplay;
        }
    });

    probes['3. Fix ClientHints FullVerList'] = await probe('3. Fix ClientHints FullVerList', p => {
        if (p.clientHints?.fullVersionList) {
            p.clientHints.fullVersionList = [
                { brand: 'Google Chrome', version: chromeVer },
                { brand: 'Chromium', version: chromeVer },
                { brand: greaseBrand, version: greaseVer }
            ];
            p.clientHints.fullVersionListDisplay = brandedDisplay;
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
            p.worker.data.highEntropy.fullVersionList = brandedDisplay;
        }
        if (p.clientHints?.fullVersionList) {
            p.clientHints.fullVersionList = [
                { brand: 'Google Chrome', version: chromeVer },
                { brand: 'Chromium', version: chromeVer },
                { brand: greaseBrand, version: greaseVer }
            ];
            p.clientHints.fullVersionListDisplay = brandedDisplay;
        }
    });

    const report = {
        target: 'https://www.apivoid.com/tools/bot-detection-test/',
        headed: ctx.headed,
        presentedUA: ua,
        brandedDisplay,
        basePayload,
        probes
    };
    const reportPath = await h.saveReport('apivoid-diagnose', report);
    console.log('Report saved to:', reportPath);
}).catch(console.error);
