const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = this.id++;
      this.callbacks.set(msgId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }
  close() { this.ws.close(); }
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join('/tmp', 'apivoid-diag-'));
  const extPath = path.resolve('.');
  const port = 9570;
  const chrome = spawn(process.env.CHROME_BIN || 'chromium', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${tempDir}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${extPath}`,
    `--disable-extensions-except=${extPath}`,
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    let targets = null;
    for (let i = 0; i < 30; i++) {
      try {
        targets = await httpGet(`http://127.0.0.1:${port}/json/list`);
        if (Array.isArray(targets) && targets.length > 0) break;
      } catch (e) {}
      await sleep(200);
    }
    const pageTarget = targets.find(t => t.type === 'page');
    const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.navigate', { url: 'https://www.apivoid.com/tools/bot-detection-test/' });
    await sleep(4000);

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
      await sleep(1000);
      return data;
    }

    console.log('--- Probing APIVoid Heuristics ---');
    await probe('0. BASE PAYLOAD', p => {});

    await probe('1. Fix Worker Intl Timezone', p => {
      if (p.worker?.data?.intl) {
        p.worker.data.intl.offsetNow = 420;
        p.worker.data.intl.offsetJan = 480;
        p.worker.data.intl.offsetJul = 420;
        p.worker.data.intl.dateString = "Sun Sep 13 2020 05:26:40 GMT-0700 (Pacific Daylight Time)";
      }
    });

    await probe('2. Fix Worker HighEntropy', p => {
      if (p.worker?.data?.highEntropy) {
        p.worker.data.highEntropy.fullVersionList = "Google Chrome 153.0.0.0, Chromium 153.0.0.0, Not_A Brand 8.0.0.0";
      }
    });

    await probe('3. Fix ClientHints FullVerList', p => {
      if (p.clientHints?.fullVersionList) {
        p.clientHints.fullVersionList = [
          { brand: 'Google Chrome', version: '153.0.0.0' },
          { brand: 'Chromium', version: '153.0.0.0' },
          { brand: 'Not_A Brand', version: '8.0.0.0' }
        ];
        p.clientHints.fullVersionListDisplay = 'Google Chrome 153.0.0.0, Chromium 153.0.0.0, Not_A Brand 8.0.0.0';
      }
    });

    await probe('4. Fix 1 + 2 + 3 combined', p => {
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

    cdp.close();
  } finally {
    chrome.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(console.error);
