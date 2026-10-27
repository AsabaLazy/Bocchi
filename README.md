# Bocchi

Privacy-first browser extension for fingerprint protection, WebRTC leak prevention, and timezone spoofing.

## Install

1. Download and unzip the latest `bocchi-v*.zip` from [Releases](https://github.com/AsabaLazy/Bocchi/releases), or [build from source](CONTRIBUTING.md#build).
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder.

## Description

Bocchi is a Manifest V3 extension that reduces the signals trackers use to link visits. It covers canvas, WebGL, audio, fonts, Workers, WebRTC leaks, timezone, location, and hardware surfaces.

Processing stays local. Language and geolocation spoofing are off by default, WebRTC full blocking is off by default, and every module can be bypassed per site. See [PRIVACY.md](PRIVACY.md) for the GeoIP disclosure.

## Changelog

See [CHANGELOG.md](CHANGELOG.md), or the [Releases](https://github.com/AsabaLazy/Bocchi/releases) page.

## Issues

Report extension bugs and feature requests in [Issues](https://github.com/AsabaLazy/Bocchi/issues).

## FAQ

See [docs/FAQ.md](docs/FAQ.md).

---

[Privacy](PRIVACY.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)
