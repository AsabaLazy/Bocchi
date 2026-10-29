# Bocchi

Privacy-first browser extension for fingerprint protection, WebRTC leak prevention, and timezone spoofing.

## Install

1. [Build from source](CONTRIBUTING.md#build), or download and unzip `bocchi-v*.zip` from [Releases](https://github.com/AsabaLazy/Bocchi/releases) when a release is published.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder or the unzipped release folder.

## Description

Bocchi is a Manifest V3 extension that reduces the signals trackers use to link visits. It covers canvas, WebGL, audio, fonts, Workers, WebRTC leaks, timezone, location, and hardware surfaces.

Processing stays local. Language and geolocation spoofing are off by default, WebRTC full blocking is off by default, and individual sites can be excepted from content-script protection. See [PRIVACY.md](PRIVACY.md) for the GeoIP disclosure.

## Changelog

See [CHANGELOG.md](CHANGELOG.md), or the [Releases](https://github.com/AsabaLazy/Bocchi/releases) page.

## Issues

Report extension bugs and feature requests in [Issues](https://github.com/AsabaLazy/Bocchi/issues).

## FAQ

See [docs/FAQ.md](docs/FAQ.md).

---

[PRD](PRD.md) · [Architecture](ARCHITECTURE.md) · [Design](DESIGN.md) · [Rules](RULES.md) · [Privacy](PRIVACY.md) · [Contributing](CONTRIBUTING.md)
