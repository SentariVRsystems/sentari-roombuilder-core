// Zero-config discovery: advertise the relay over mDNS/Bonjour so headsets on
// the same WiFi find the instructor's laptop automatically — no typing an IP.
//
// We publish `_sentari._tcp.local` on the relay's port. Headsets browse for
// that service (see unity-client/SentariDiscovery.cs) and connect to the
// advertised host+port. Works on Mac/Windows/Linux; no native build.
//
// Advertising is best-effort: if the dependency is missing or the network
// blocks mDNS, the relay still runs and headsets can fall back to a manual IP.
//
// ── Why this file hand-rolls a responder instead of using bonjour-service ──
// The headset asks with the mDNS "unicast response" (QU) bit set, from an
// EPHEMERAL udp port — it has to, because Android won't let it own :5353. A
// socket bound to an ephemeral port cannot receive traffic addressed to the
// multicast group on :5353, so the ONLY reply it can ever hear is one sent
// directly back to the port it asked from.
//
// bonjour-service never does that. Its Server.respondToQuery() takes the query
// but drops the sender's rinfo, so multicast-dns falls back to broadcasting the
// answer at 224.0.0.251:5353 — which the headset is deaf to. (dns-packet also
// mangles the QU class into "UNKNOWN_32769" and discards the flag, so nothing
// downstream could honor it anyway.) macOS never hit this because we hand off
// to dns-sd there and Apple's mDNSResponder answers QU queries correctly —
// which is exactly why auto-pairing worked on a Mac and never on Windows.
//
// So: answer every query BOTH unicast (the one that actually reaches the
// headset) and multicast (for conventional browsers).

import os from "os";

const SERVICE = "_sentari._tcp.local";

// mDNS instance labels are arbitrary text, but a "." would split into two DNS
// labels and rename the service, so collapse it like bonjour-service does.
const label = (s) => String(s).split(".").join("-");

// The A-record name we publish, and the SRV target that points at it. A
// synthesized name rather than os.hostname() so it is always a legal DNS label
// (Windows machine names arrive with all sorts in them) and so two relays on one
// LAN can't claim the same host name.
function hostName(relayName) {
  const slug =
    String(relayName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "relay";
  return `sentari-${slug}.local`;
}

// Every real (non-loopback) IPv4 address on this machine, with its netmask.
function ipv4Interfaces() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      // Node <18 reports family as a string, newer as a number.
      if (a.internal || (a.family !== "IPv4" && a.family !== 4)) continue;
      out.push({ address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

const toInt = (ip) => ip.split(".").reduce((n, o) => ((n << 8) >>> 0) + (Number(o) & 255), 0) >>> 0;

function sameSubnet(a, b, mask) {
  if (!mask) return false;
  const m = toInt(mask);
  return ((toInt(a) & m) >>> 0) === ((toInt(b) & m) >>> 0);
}

// Windows boxes are full of adapters that look like LAN but route nowhere —
// Hyper-V/WSL vEthernet, VirtualBox host-only, Docker. Rank them so the real
// WiFi address sorts LAST (see pickAddresses for why last is the good slot).
function rank(ip) {
  if (ip.startsWith("169.254.")) return 0; // link-local: no DHCP happened
  if (ip.startsWith("192.168.56.")) return 1; // VirtualBox host-only
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1; // Docker / WSL / Hyper-V
  if (ip.startsWith("10.")) return 2;
  if (ip.startsWith("192.168.")) return 3;
  return 2;
}

// Which of our addresses to put in the A records, given who is asking.
//
// The headset keeps A records in a dictionary keyed by host name, so the LAST
// one in the packet is the one it connects to. When we can see which of our
// subnets the querier is on, send only that address and the ambiguity is gone;
// otherwise send them all worst-first so the most plausible LAN address is the
// one that survives.
function pickAddresses(querierIp) {
  const ifaces = ipv4Interfaces();
  if (querierIp) {
    const onLink = ifaces.filter((i) => sameSubnet(i.address, querierIp, i.netmask));
    if (onLink.length) return onLink.map((i) => i.address);
  }
  return ifaces.map((i) => i.address).sort((a, b) => rank(a) - rank(b));
}

const nameEq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export async function advertise(port, name = "Sentari Command") {
  // macOS: register with the system's mDNSResponder via dns-sd. It owns UDP
  // 5353 and answers QU queries correctly, so on a Mac this is both the
  // best-behaved and the least code.
  if (process.platform === "darwin") {
    try {
      const { spawn } = await import("child_process");
      const child = spawn("dns-sd", ["-R", name, "_sentari._tcp", ".", String(port), "role=relay"], {
        stdio: "ignore",
      });
      let failed = false;
      child.on("error", () => { failed = true; });
      // Give spawn a tick to fail (no dns-sd on this box) before we commit.
      await new Promise((r) => setImmediate(r));
      if (!failed) {
        const stop = () => { try { child.kill(); } catch {} };
        process.on("exit", stop);
        console.log("  Discovery : advertising _sentari._tcp via dns-sd — headsets auto-find this laptop");
        return () => { stop(); return Promise.resolve(); };
      }
    } catch {
      /* fall through to the built-in responder */
    }
  }

  try {
    const { default: makeMdns } = await import("multicast-dns");
    const mdns = makeMdns();
    const host = hostName(name);
    const fqdn = `${label(name)}.${SERVICE}`;

    const recordsFor = (querierIp) => ({
      answers: [{ name: SERVICE, type: "PTR", ttl: 120, data: fqdn }],
      additionals: [
        { name: fqdn, type: "SRV", ttl: 120, data: { port: Number(port), target: host, priority: 0, weight: 0 } },
        { name: fqdn, type: "TXT", ttl: 120, data: [`role=relay`, `name=${name}`] },
        ...pickAddresses(querierIp).map((ip) => ({ name: host, type: "A", ttl: 120, data: ip })),
      ],
    });

    mdns.on("query", (query, rinfo) => {
      const questions = query.questions || [];
      const wanted = questions.some(
        (q) =>
          (nameEq(q.name, SERVICE) && (q.type === "PTR" || q.type === "ANY")) ||
          (nameEq(q.name, fqdn) && (q.type === "SRV" || q.type === "ANY"))
      );
      if (!wanted) return;
      // Unicast FIRST — this is the reply the headset can actually receive.
      if (rinfo && rinfo.address && rinfo.port) {
        mdns.respond(recordsFor(rinfo.address), { address: rinfo.address, port: rinfo.port });
      }
      mdns.respond(recordsFor(rinfo && rinfo.address));
    });

    // Errors here are never fatal: a blocked 5353 means no auto-discovery, not
    // a dead relay.
    mdns.on("error", (e) => console.warn(`  Discovery : mDNS error (${e.message})`));
    mdns.on("warning", () => {});

    // Unsolicited announcements, so anything already browsing sees us appear.
    const announce = () => { try { mdns.respond(recordsFor(null)); } catch {} };
    const timers = [setTimeout(announce, 100), setTimeout(announce, 1000), setTimeout(announce, 3000)];

    console.log("  Discovery : advertising _sentari._tcp — headsets auto-find this laptop");
    return () =>
      new Promise((resolve) => {
        for (const t of timers) clearTimeout(t);
        try {
          mdns.destroy(() => resolve());
        } catch {
          resolve();
        }
      });
  } catch (e) {
    console.warn(`  Discovery : mDNS unavailable (${e.message}) — headsets need a manual IP`);
    return () => Promise.resolve();
  }
}
