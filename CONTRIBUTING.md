# Contributing

## Build

```bash
git clone https://github.com/AsabaLazy/Bocchi.git
cd Bocchi
./package-extension.sh
```

The packager writes `bocchi-v<version>.zip` and verifies its allowlist against `manifest.json`, `package.json`, and `CHANGELOG.md`.

To load the source directly, open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select the repository folder.

## Test

Node.js 22+ is required. Live tests also need a local Chromium.

```bash
npm test
npm run test:tz
npm run test:extension
npm run bench
npm run soak
```

Set `CHROME_BIN` when Chromium is not on `PATH`. Reports are written to `tests/reports/`.
