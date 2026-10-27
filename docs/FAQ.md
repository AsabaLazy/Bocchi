# FAQ

### Does Bocchi make me anonymous?

No. It reduces fingerprint linkability; it does not hide your IP address or make the browser anonymous.

### Why do canvas and audio values change between page loads?

A stable value can identify a browser. A per-load value cannot link separate visits.

### Will it break a site?

Some sites depend on exact rendering or WebRTC behavior. Add the site to **Website exceptions** to stop script injection there.

### Does it work in Chrome?

Bocchi targets Manifest V3. Chrome 111+ is the declared minimum; current smoke tests run against Chrome for Testing 156.

### Does it send data anywhere?

Timezone protection is on by default and may query a GeoIP provider for the exit timezone. Turn it off to stop requests. Details are in [PRIVACY.md](../PRIVACY.md).
