const h = require('./lib/live_harness');

h.runWithRetry('apivoid-tamper', { headed: process.env.HEADED === '1' }, async (ctx) => {
  const { cdp } = ctx;

  console.log('Connected to CDP');

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log('Navigating to https://www.apivoid.com/tools/bot-detection-test/ ...');
  await cdp.send('Page.navigate', { url: 'https://www.apivoid.com/tools/bot-detection-test/' });

  // Wait a few seconds for page and extension injection
  await h.sleep(4000);

  // Bare-browser guard: without the engine injected, the tamper probe would
  // emit plausible-but-misleading pristine values, so fail loudly instead.
  await h.ensureEngine(cdp);

  // Run APIVoid test logic in page context
  const testResult = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
        var INTEGRITY_ACCESSORS = [
          'webdriver', 'platform', 'vendor', 'vendorSub', 'language', 'languages',
          'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'userAgent',
          'appVersion', 'appName', 'product', 'productSub', 'plugins', 'mimeTypes',
          'buildID', 'oscpu', 'connection', 'userAgentData'
        ];

        function ownerInChain(obj, prop) {
          var cursor = obj;
          while (cursor) {
            if (Object.prototype.hasOwnProperty.call(cursor, prop)) return cursor;
            cursor = Object.getPrototypeOf(cursor);
          }
          return null;
        }

        function collectPrototypeIntegrity(out, pristineToString) {
          function isNative(fn) {
            if (typeof fn !== 'function') return true;
            try { return pristineToString.call(fn).indexOf('[native code]') !== -1; } catch (e) { return true; }
          }
          try { out.nativeToStringIntact = isNative(Function.prototype.toString); } catch (e) {}
          for (var i = 0; i < INTEGRITY_ACCESSORS.length; i++) {
            var prop = INTEGRITY_ACCESSORS[i];
            try {
              var owner = ownerInChain(navigator, prop);
              out.navigatorChain[prop] = !!owner;
              if (!owner) continue;
              var desc = Object.getOwnPropertyDescriptor(owner, prop);
              if (desc && desc.get && !isNative(desc.get)) out.patchedAccessors.push(prop);
            } catch (e) {}
          }
          var methodTargets = [];
          function addMethod(label, host, name) {
            try { if (host && typeof host[name] === 'function') methodTargets.push([label, host[name]]); } catch (e) {}
          }
          addMethod('Function.toString', Function.prototype, 'toString');
          addMethod('Object.getOwnPropertyDescriptor', Object, 'getOwnPropertyDescriptor');
          addMethod('Date.getTimezoneOffset', Date.prototype, 'getTimezoneOffset');
          addMethod('matchMedia', window, 'matchMedia');
          try { addMethod('storage.estimate', Object.getPrototypeOf(navigator.storage), 'estimate'); } catch (e) {}
          try { addMethod('mediaDevices.enumerateDevices', Object.getPrototypeOf(navigator.mediaDevices), 'enumerateDevices'); } catch (e) {}
          try { addMethod('permissions.query', Object.getPrototypeOf(navigator.permissions), 'query'); } catch (e) {}
          try { addMethod('userAgentData.getHighEntropyValues', Object.getPrototypeOf(navigator.userAgentData), 'getHighEntropyValues'); } catch (e) {}
          try { addMethod('canvas.toDataURL', HTMLCanvasElement.prototype, 'toDataURL'); } catch (e) {}
          try { addMethod('canvas.getContext', HTMLCanvasElement.prototype, 'getContext'); } catch (e) {}
          try { addMethod('2d.getImageData', CanvasRenderingContext2D.prototype, 'getImageData'); } catch (e) {}
          try { addMethod('webgl.getParameter', WebGLRenderingContext.prototype, 'getParameter'); } catch (e) {}
          try { addMethod('webgl.getExtension', WebGLRenderingContext.prototype, 'getExtension'); } catch (e) {}
          try { addMethod('audio.getChannelData', AudioBuffer.prototype, 'getChannelData'); } catch (e) {}
          for (var m = 0; m < methodTargets.length; m++) {
            if (!isNative(methodTargets[m][1])) out.patchedMethods.push(methodTargets[m][0]);
          }
        }

        var out = {
          supported: false, ran: false, error: '',
          userAgent: '', platform: '', languages: [],
          hardwareConcurrency: null, deviceMemory: null, webdriver: null, pluginsCount: null,
          screenWidth: null, screenHeight: null, colorDepth: null,
          navigatorOwnProps: [],
          pristineReference: false, nativeToStringIntact: null,
          patchedAccessors: [], patchedMethods: [], navigatorChain: {},
          toStringOutputForWebdriver: null,
          iframeToStringEqualsTopToString: null
        };

        var frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.setAttribute('title', 'bd-realm');
        frame.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;left:-9999px;';
        frame.src = 'about:blank';
        document.body.appendChild(frame);
        var win = frame.contentWindow;
        if (!win || !win.navigator) { out.error = 'no-contentwindow'; return out; }
        out.supported = true;
        out.ran = true;
        var inav = win.navigator;
        try { out.userAgent = String(inav.userAgent || ''); } catch (e) {}
        try { out.platform = String(inav.platform || ''); } catch (e) {}
        try { out.languages = (inav.languages || []).slice(); } catch (e) {}
        try { out.hardwareConcurrency = (inav.hardwareConcurrency !== undefined) ? inav.hardwareConcurrency : null; } catch (e) {}
        try { out.deviceMemory = (inav.deviceMemory !== undefined) ? inav.deviceMemory : null; } catch (e) {}
        try { out.webdriver = (inav.webdriver !== undefined) ? !!inav.webdriver : null; } catch (e) {}
        try { out.pluginsCount = inav.plugins ? inav.plugins.length : null; } catch (e) {}
        try { out.navigatorOwnProps = Object.getOwnPropertyNames(inav); } catch (e) {}
        try {
          var pristineToString = win.Function.prototype.toString;
          out.iframeToStringEqualsTopToString = (win.Function.prototype.toString === window.Function.prototype.toString);
          if (typeof pristineToString === 'function') {
            out.pristineReference = true;
            collectPrototypeIntegrity(out, pristineToString);
            var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'webdriver');
            if (desc && desc.get) {
              out.toStringOutputForWebdriver = pristineToString.call(desc.get);
            }
          }
        } catch (e) {
          out.error = e.message;
        }
        if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
        return out;
      })()`,
    returnByValue: true
  });

  console.log('\n=== APIVoid Prototype Integrity Test Result ===');
  console.log(JSON.stringify(testResult.result?.value, null, 2));

  const report = {
    scenarios: {
      prototypeIntegrity: testResult.result?.value
    }
  };
  const reportPath = await h.saveReport('apivoid-tamper', report);
  console.log(`Report saved to: ${reportPath}`);

  cdp.close();
}).catch(err => {
  console.error(err);
  process.exit(1);
});
