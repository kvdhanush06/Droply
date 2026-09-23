/** About / Privacy / Terms — original Droply copy. */

export function AboutPage() {
  return (
    <article className="prose">
      <h1>About Droply</h1>
      <p>
        Droply is a small tool for moving files and text between your own devices — or a friend’s —
        without uploading anything to a server. Open the site, create a room, connect a second device
        with a link, code or QR scan, and drop whatever you want to send.
      </p>
      <h2>How it works</h2>
      <p>
        The Droply server has exactly one job: helping two browsers find each other. It relays the tiny
        signaling messages (SDP offers, answers and ICE candidates) that WebRTC needs to open a direct
        connection. After that, the file itself streams device-to-device over an encrypted WebRTC
        DataChannel — it never passes through Droply’s servers in the normal peer-to-peer path.
      </p>
      <h2>Rooms are temporary</h2>
      <p>
        Rooms live only in server memory. They expire after a period of inactivity and vanish entirely
        when everyone leaves or the server restarts. There is no database of transfers, no file storage
        and no accounts.
      </p>
      <h2>When direct connections aren’t possible</h2>
      <p>
        Some networks (strict firewalls, symmetric NATs, captive portals) block direct peer connections.
        If a TURN relay is configured by the operator, traffic can be relayed through that server as a
        fallback. Without one, Droply will tell you the connection could not be established instead of
        silently failing.
      </p>
    </article>
  );
}

export function PrivacyPage() {
  return (
    <article className="prose">
      <h1>Privacy</h1>
      <p>
        Droply is designed to move your data between your devices with as little server involvement as
        possible.
      </p>
      <h2>What the server sees</h2>
      <ul>
        <li>Room codes and anonymous peer identifiers, kept in memory only.</li>
        <li>WebRTC signaling metadata (connection descriptions and network candidates).</li>
        <li>Operational logs such as “room created” or “peer disconnected” — never file or message contents.</li>
      </ul>
      <h2>What the server never sees</h2>
      <ul>
        <li>File contents — they stream directly between browsers over an encrypted WebRTC DataChannel (DTLS).</li>
        <li>Text and clipboard contents you send.</li>
        <li>Your files are never written to disk on the server; there is no upload step.</li>
      </ul>
      <h2>TURN relays</h2>
      <p>
        If the operator configures a TURN server and your network blocks direct connections, your traffic
        may be relayed through that TURN server. Relayed traffic is still encrypted with DTLS, but the
        relay operator could observe connection metadata (timing, volume). If no TURN server is
        configured, connections that can’t be established directly simply fail with a clear message.
      </p>
      <h2>Data you share stays between peers</h2>
      <p>
        Anyone with the room link can join until the room fills or expires, so treat room links like
        invitations: share them only with devices and people you trust.
      </p>
      <h2>Stored on this device only</h2>
      <ul>
        <li>Your device name and your transfer history (file names, sizes, who sent what, timestamps) live in this browser’s local storage. They are never sent to the server and survive a page refresh — use “Clear history” in the history panel to erase them.</li>
        <li>Your device name is shared directly with the devices in your room so they can show who is sending what.</li>
      </ul>
    </article>
  );
}

export function TermsPage() {
  return (
    <article className="prose">
      <h1>Terms of use</h1>
      <p>
        Droply is provided “as is”, without warranties of any kind. By using it you agree that:
      </p>
      <ul>
        <li>You will only transfer content you have the right to share.</li>
        <li>You will not use Droply to break the law or to harm others.</li>
        <li>You understand transfers happen directly between browsers and that network conditions may
          prevent connections.</li>
        <li>Rooms are ephemeral; Droply is not a storage or backup service.</li>
      </ul>
      <p>
        The service may be modified, limited or discontinued at any time. Abuse prevention measures
        (rate limits, room size caps, message size caps) are in place to keep the service usable for
        everyone.
      </p>
    </article>
  );
}

export function NotFoundPage() {
  return (
    <article className="prose" style={{ textAlign: 'center', margin: '0 auto' }}>
      <h1>404 — nothing here</h1>
      <p>The page you’re looking for doesn’t exist. Maybe the room link was mistyped?</p>
      <a href="/" className="btn btn-primary">
        Back to Droply
      </a>
    </article>
  );
}
