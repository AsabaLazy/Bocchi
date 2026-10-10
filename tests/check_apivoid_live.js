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
  const tempDir = fs.mkdtempSync(path.join('/tmp', 'apivoid-check-'));
  const extPath = path.resolve('.');
  const port = 9580;
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

    console.log('Navigating to APIVoid test page...');
    await cdp.send('Page.navigate', { url: 'https://www.apivoid.com/tools/bot-detection-test/' });
    await sleep(5000);

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
    try {
      const data = JSON.parse(checkRes.result?.value || '{}');
      console.log('Parsed verdict:', JSON.stringify(data.verdict, null, 2));
      console.log('Parsed groups:', JSON.stringify(data.groups, null, 2));
      console.log('Parsed derived:', JSON.stringify(data.derived, null, 2));
    } catch (e) {
      console.error('Parse error:', e);
    }

    cdp.close();
  } finally {
    chrome.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(console.error);
