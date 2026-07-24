// Zero-config discovery: advertise the relay over mDNS/Bonjour so headsets on
// the same WiFi find the instructor's laptop automatically — no typing an IP.
//
// We publish `_sentari._tcp.local` on the relay's port. Headsets browse for
// that service (see unity-client/SentariDiscovery.cs) and connect to the
// advertised host+port. Works on Mac/Windows/Linux; no native build (uses the
// pure-JS `bonjour-service`).
//
// Advertising is best-effort: if the dependency is missing or the network
// blocks mDNS, the relay still runs and headsets can fall back to a manual IP.

export async function advertise(port, name = "Sentari Command") {
  // macOS: register with the system's mDNSResponder via dns-sd. The pure-JS
  // advertiser below can announce but never HEARS queries on macOS (the system
  // responder owns UDP 5353), so clients that query — like the headsets'
  // SentariDiscovery — get no answer. dns-sd answers queries correctly.
  if (process.platform === "darwin") {
    try {
      const { spawn } = await import("child_process");
      const child = spawn("dns-sd", ["-R", name, "_sentari._tcp", ".", String(port), "role=relay"], {
        stdio: "ignore",
      });
      child.on("error", () => {}); // fall through silently; bonjour path below still ran
      const stop = () => { try { child.kill(); } catch {} };
      process.on("exit", stop);
      console.log("  Discovery : advertising _sentari._tcp via dns-sd — headsets auto-find this laptop");
      return () => { stop(); return Promise.resolve(); };
    } catch {
      /* fall through to bonjour-service */
    }
  }
  try {
    const { Bonjour } = await import("bonjour-service");
    const bonjour = new Bonjour();
    bonjour.publish({
      name,
      type: "sentari", // → advertised as _sentari._tcp.local
      protocol: "tcp",
      port: Number(port),
      txt: { role: "relay", ws: `ws://:${port}` },
    });
    console.log("  Discovery : advertising _sentari._tcp — headsets auto-find this laptop");
    return () =>
      new Promise((resolve) => {
        try {
          bonjour.unpublishAll(() => {
            bonjour.destroy();
            resolve();
          });
        } catch {
          resolve();
        }
      });
  } catch (e) {
    console.warn(`  Discovery : mDNS unavailable (${e.message}) — headsets need a manual IP`);
    return () => Promise.resolve();
  }
}
