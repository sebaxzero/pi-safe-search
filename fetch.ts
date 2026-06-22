import { lookup } from "node:dns/promises";
import { sanitize } from "./sanitize.ts";

const BLOCKED_PORTS = new Set([
  21, 22, 23, 25, 53, 110, 143, 389, 445,
  3306, 5432, 5900, 6379, 8080, 8443, 9200, 27017,
]);
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB hard cap during streaming
const MAX_TEXT_CHARS = 8_000;            // ponytail: 8KB returned to LLM; raise if content feels truncated
const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 5;

// RFC-1918 + loopback + link-local + reserved ranges as [lo, hi] inclusive (uint32)
const PRIVATE_RANGES: [number, number][] = [
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8   loopback
  [0x0a000000, 0x0affffff], // 10.0.0.0/8    private
  [0xac100000, 0xac1fffff], // 172.16.0.0/12 private
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16 private
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24  IANA special-purpose
  [0xe0000000, 0xefffffff], // 224.0.0.0/4   multicast
  [0xf0000000, 0xffffffff], // 240.0.0.0/4   reserved
];

function ipv4ToUint32(ip: string): number {
  return ip.split(".").reduce((acc, o) => ((acc << 8) | parseInt(o, 10)) >>> 0, 0);
}

function isBlockedIp(ip: string): boolean {
  // IPv6: block loopback and ULA
  if (ip.includes(":")) {
    return ip === "::1" || ip.toLowerCase().startsWith("fd") || ip.toLowerCase().startsWith("fe80");
  }
  const n = ipv4ToUint32(ip);
  return PRIVATE_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

async function validateUrl(raw: string): Promise<URL> {
  if (raw.length > MAX_URL_LENGTH) throw new Error("URL exceeds maximum length");
  if (/[\x00-\x1f\x7f]/.test(raw)) throw new Error("URL contains control characters");

  const u = new URL(raw); // throws on malformed URL

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`Blocked scheme: ${u.protocol}`);
  }

  const port = u.port ? parseInt(u.port, 10) : (u.protocol === "https:" ? 443 : 80);
  if (BLOCKED_PORTS.has(port)) throw new Error(`Blocked port: ${port}`);

  // Resolve hostname and check against blocked IP ranges
  const { address } = await lookup(u.hostname);
  if (isBlockedIp(address)) {
    throw new Error(`Blocked: resolves to private/internal address`);
  }

  return u;
}

export async function safeFetch(rawUrl: string, signal?: AbortSignal, hops = 0): Promise<string> {
  if (hops > MAX_REDIRECTS) throw new Error("Too many redirects");

  const u = await validateUrl(rawUrl);

  const res = await fetch(u.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; pi-web-search/1.0)" },
    redirect: "manual", // manual redirect so we re-validate each hop
    signal,
  });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) throw new Error("Redirect with no Location header");
    return safeFetch(new URL(location, u).toString(), signal, hops + 1);
  }

  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);

  const contentType = res.headers.get("content-type") ?? "text/html";
  const allowedTypes = ["text/html", "text/plain", "application/json", "text/markdown", "text/xml", "application/xml"];
  if (!allowedTypes.some((t) => contentType.includes(t))) {
    throw new Error(`Blocked content-type: ${contentType}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); break; }
    chunks.push(Buffer.from(value));
  }
  const raw = Buffer.concat(chunks).toString("utf8");

  const text = contentType.includes("text/html")
    ? extractText(raw, u.toString())
    : sanitize(raw);

  return text.slice(0, MAX_TEXT_CHARS);
}

function extractText(html: string, sourceUrl: string): string {
  let s = html;
  for (const tag of ["script", "style", "nav", "footer", "header", "aside", "noscript"]) {
    s = s.replace(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1]?.trim() ?? "";
  return [title && `# ${sanitize(title)}`, `Source: ${sourceUrl}`, sanitize(s)]
    .filter(Boolean)
    .join("\n\n");
}
