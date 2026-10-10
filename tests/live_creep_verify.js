const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
    this.events = new Map();

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
      } else if (msg.method) {
        const handlers = this.events.get(msg.method) || [];
        handlers.forEach(h => h(msg.params));
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

  on(event, handler) {
    if (!this.events.has(event)) this.events.set(event, []);
    this.events.get(event).push(handler);
  }

  close() {
    this.ws.close();
  }
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join('/tmp', 'creep-verify-'));
  const extPath = path.resolve(__dirname, '..');
  const port = 9333;
  const chromeBin = process.env.CHROME_BIN || 'chromium';

  console.log(`Starting Chromium with extension from: ${extPath}`);
  const chromeProcess = spawn(chromeBin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${tempDir}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${extPath}`,
    `--disable-extensions-except=${extPath}`,
    'about:blank'
  ], {
    stdio: 'ignore'
  });

  try {
    // Wait for CDP server
    let targets = null;
    for (let i = 0; i < 30; i++) {
      try {
        targets = await httpGet(`http://127.0.0.1:${port}/json/list`);
        if (Array.isArray(targets) && targets.length > 0) break;
      } catch (e) {}
      await sleep(200);
    }

    if (!targets || targets.length === 0) {
      throw new Error('Failed to connect to Chromium CDP port');
    }

    const pageTarget = targets.find(t => t.type === 'page');
    if (!pageTarget) throw new Error('No page target found');

    const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await cdp.ready;
    console.log('Connected to CDP');

    const uncaughtExceptions = [];
    cdp.on('Runtime.exceptionThrown', (params) => {
      uncaughtExceptions.push(params);
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('Navigating to https://abrahamjuliot.github.io/creepjs/ ...');
    await cdp.send('Page.navigate', { url: 'https://abrahamjuliot.github.io/creepjs/' });

    // Wait for fingerprint generation
    let finished = false;
    let evalResult = null;
    const startTime = Date.now();

    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      try {
        const res = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const hasFP = !!window.Fingerprint;
            const container = document.querySelector('#fingerprint-data');
            const hasContent = container && container.children.length > 0;
            const hasClass = container && (document.querySelector('.col-four') || document.querySelector('.fuzzy-ui'));
            
            // Check if still calculating
            const timeElapsed = document.querySelector('.time') ? document.querySelector('.time').innerText : '';
            return {
              hasFP,
              hasContent: !!hasContent,
              timeElapsed,
              readyState: document.readyState
            };
          })()`,
          returnByValue: true
        });

        const status = res.result?.value;
        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
        process.stdout.write(`\r[${elapsedSec}s] Status: fp=${status?.hasFP}, content=${status?.hasContent}, ready=${status?.readyState}`);

        // Creepjs finishes when window.Fingerprint is populated and has all data
        const checkDone = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            if (!window.Fingerprint) return null;
            const fp = window.Fingerprint;
            // Check essential keys
            if (!fp.canvas2d || !fp.canvasWebgl || !fp.offlineAudioContext) return null;
            return true;
          })()`,
          returnByValue: true
        });

        if (checkDone.result?.value === true) {
          console.log('\nCreepJS fingerprint generated! Gathering detailed audit results...');
          finished = true;
          break;
        }
      } catch (err) {
        // ignore while loading
      }
    }

    if (!finished) {
      console.log('\nWarning: Timeout waiting for full Fingerprint completion, inspecting DOM anyway...');
    }

    // Give DOM 1 second to settle rendering
    await sleep(1000);

    const auditRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const fp = window.Fingerprint || {};
        const trashBin = fp.trash?.trashBin || [];
        const capturedErrors = fp.capturedErrors || [];
        const totalLies = (fp.lies && fp.lies.totalLies !== undefined) ? fp.lies.totalLies : (fp.trash?.totalLies || 0);

        // Scan all .bold-fail elements
        const boldFailEls = Array.from(document.querySelectorAll('.bold-fail'));
        const boldFailDetails = boldFailEls.map(el => {
          return {
            text: el.innerText,
            outerHTML: el.outerHTML,
            parentText: el.parentElement ? el.parentElement.innerText.replace(/\\s+/g, ' ').trim() : ''
          };
        });

        // Scan all .lies elements
        const liesEls = Array.from(document.querySelectorAll('.lies'));
        const liesDetails = liesEls.map(el => ({
          text: el.innerText,
          parentText: el.parentElement ? el.parentElement.innerText.replace(/\\s+/g, ' ').trim() : ''
        }));

        // Get Audio details
        const audioInfo = fp.offlineAudioContext ? {
          sampleSum: fp.offlineAudioContext.sampleSum,
          compressorGainReduction: fp.offlineAudioContext.compressorGainReduction,
          matching: fp.offlineAudioContext.binsSample && fp.offlineAudioContext.copySample ? ('' + fp.offlineAudioContext.binsSample === '' + fp.offlineAudioContext.copySample) : null,
          lied: fp.offlineAudioContext.lied,
          noise: fp.offlineAudioContext.noise
        } : null;

        // Get Canvas details
        const canvas2dInfo = fp.canvas2d ? {
          lied: fp.canvas2d.lied
        } : null;

        // Get Headless and Stealth ratings
        const headlessGrade = document.querySelector('.headless-rating')?.innerText || (fp.resistance?.headless) || '';
        const stealthGrade = document.querySelector('.stealth-rating')?.innerText || (fp.resistance?.stealth) || '';

        return {
          trashBin,
          capturedErrors,
          totalLies,
          boldFailCount: boldFailEls.length,
          boldFailDetails,
          liesCount: liesEls.length,
          liesDetails,
          audioInfo,
          canvas2dInfo,
          headlessGrade,
          stealthGrade,
          workerScope: fp.workerScope,
          webrtc: fp.webrtc,
          canvasWebgl: fp.canvasWebgl,
          fonts: fp.fonts,
          screen: fp.screen,
          resistance: fp.resistance
        };
      })()`,
      returnByValue: true
    });

    console.log('\n================ UNCAUGHT EXCEPTIONS ================');
    console.log(`Count: ${uncaughtExceptions.length}`);
    uncaughtExceptions.forEach((e, idx) => {
      console.log(`[#${idx + 1}]`, JSON.stringify(e, null, 2));
    });
    console.log('====================================================\n');

    const val = auditRes.result?.value || {};
    console.log('================ AUDIT SUMMARY ================');
    console.log('trashBin:', JSON.stringify(val.trashBin));
    console.log('totalLies:', val.totalLies);
    console.log('capturedErrors:', JSON.stringify(val.capturedErrors));
    console.log('boldFailCount:', val.boldFailCount);
    if (val.boldFailDetails && val.boldFailDetails.length > 0) {
      console.log('boldFailDetails:', JSON.stringify(val.boldFailDetails, null, 2));
    }
    console.log('liesCount:', val.liesCount);
    if (val.liesDetails && val.liesDetails.length > 0) {
      console.log('liesDetails:', JSON.stringify(val.liesDetails, null, 2));
    }
    console.log('headlessGrade:', val.headlessGrade);
    console.log('stealthGrade:', val.stealthGrade);
    console.log('workerCurrency:', val.workerScope?.systemCurrencyLocale);
    console.log('audioInfo:', JSON.stringify(val.audioInfo, null, 2));
    console.log('===============================================\n');

    cdp.close();
  } finally {
    chromeProcess.kill('SIGKILL');
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

main().catch(err => {
  console.error('Fatal error in verify:', err);
  process.exit(1);
});
