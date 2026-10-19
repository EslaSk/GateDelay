/**
 * In-memory IPFS store for Next.js API routes.
 * Mirrors Backend/services/ipfsService.js for frontend integration.
 *
 * #1188 — CID derivation
 * ──────────────────────
 * Instead of generating random Qm-prefixed strings, every upload now derives
 * a deterministic content identifier from the payload bytes:
 *
 *   1. Serialise the payload to UTF-8 JSON.
 *   2. Compute SHA-256 of those bytes (Web Crypto / Node crypto).
 *   3. Prepend the CIDv1 multihash / multicodec varint prefix for
 *      dag-json + sha2-256 and base32-encode the result → a "bafy…" CID.
 *
 * The same content always yields the same CID, and the CID encodes the hash
 * of the exact bytes stored.  A caller can independently hash the payload and
 * compare it to verify the identifier without contacting a gateway.
 */

/** Public Pinata gateway — never a localhost production default. */
const FALLBACK_GATEWAY = "https://gateway.pinata.cloud/ipfs/";

const storage = new Map<string, unknown>();
const pinnedHashes = new Set<string>();

function resolveGatewayBase(): string {
  const configured = process.env.NEXT_PUBLIC_IPFS_GATEWAY?.trim();
  if (configured) {
    const base = configured.endsWith("/") ? configured : `${configured}/`;
    if (
      process.env.NODE_ENV === "production" &&
      /localhost|127\.0\.0\.1/i.test(base)
    ) {
      throw new Error(
        "NEXT_PUBLIC_IPFS_GATEWAY points at localhost in a production build. " +
          "Set it to a public gateway (see Frontend/.env.example).",
      );
    }
    return base;
  }
  return FALLBACK_GATEWAY;
}

// ---------------------------------------------------------------------------
// CID helpers
// ---------------------------------------------------------------------------

/**
 * RFC 4648 §6 base32 alphabet (lower-case, no padding).
 * Used by CIDv1 to produce the familiar "bafy…" prefix.
 */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/**
 * Compute SHA-256 of `bytes` using the platform crypto available in both the
 * Node.js runtime (globalThis.crypto in Node ≥ 20, or require("crypto")) and
 * the browser / Edge runtime.
 */
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  if (
    typeof globalThis !== "undefined" &&
    globalThis.crypto?.subtle
  ) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return new Uint8Array(digest);
  }

  // Node.js fallback (no Web Crypto available — e.g. older test environments).
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(bytes).digest();
  return new Uint8Array(hash);
}

/**
 * Derive a CIDv1 (dag-json + sha2-256, base32) from `bytes`.
 *
 * Binary layout of the CIDv1 multihash prefix (all varints, 1-byte values ≤ 127):
 *   [0x01]  — CID version 1
 *   [0x0129] — codec: dag-json (varint 0x0129 = two bytes: 0xa9 0x02 in little-endian)
 *   [0x12]  — multihash function: sha2-256
 *   [0x20]  — digest length: 32 bytes
 *   … 32 bytes of SHA-256 digest …
 *
 * The whole thing is base32-encoded (no padding) and prefixed with "b" (the
 * multibase prefix for base32lower), producing the canonical "bafy…" string.
 */
async function deriveCIDv1(bytes: Uint8Array): Promise<string> {
  const digest = await sha256(bytes);

  // dag-json codec varint 0x0129 encodes as two bytes in unsigned LEB128:
  //   low 7 bits with continuation bit set: 0xa9, then high bits: 0x02
  const prefix = new Uint8Array([
    0x01,       // CID version
    0xa9, 0x02, // dag-json codec varint (0x0129)
    0x12,       // sha2-256 hash function
    0x20,       // 32-byte digest length
  ]);

  const cidBytes = new Uint8Array(prefix.length + digest.length);
  cidBytes.set(prefix, 0);
  cidBytes.set(digest, prefix.length);

  // "b" is the multibase prefix for base32lower (RFC 4648, no padding).
  return "b" + base32Encode(cidBytes);
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

export async function uploadJSON(
  data: unknown,
  options: { name?: string } = {}
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const hash = await deriveCIDv1(bytes);
  storage.set(hash, { data, metadata: { name: options.name, uploadedAt: new Date().toISOString() } });
  pinnedHashes.add(hash);
  return hash;
}

export async function uploadFile(
  content: string,
  fileName: string
): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const hash = await deriveCIDv1(bytes);
  storage.set(hash, { content, fileName, uploadedAt: new Date().toISOString() });
  pinnedHashes.add(hash);
  return hash;
}

export async function retrieve(hash: string): Promise<unknown> {
  const entry = storage.get(hash);
  if (!entry) throw new Error(`Failed to retrieve data from IPFS: hash ${hash} not found`);
  if (typeof entry === "object" && entry !== null && "data" in entry) {
    return (entry as { data: unknown }).data;
  }
  return entry;
}

export async function pinHash(hash: string, name?: string): Promise<boolean> {
  if (!storage.has(hash)) throw new Error(`Hash ${hash} not found`);
  pinnedHashes.add(hash);
  if (name) {
    const entry = storage.get(hash);
    if (typeof entry === "object" && entry !== null) {
      (entry as Record<string, unknown>).pinName = name;
    }
  }
  return true;
}

export function getGatewayUrl(hash: string): string {
  if (!hash || typeof hash !== "string") {
    throw new Error("IPFS hash is required to build a gateway URL");
  }
  return `${resolveGatewayBase()}${hash}`;
}

export function getStorageStatus(hash: string): {
  stored: boolean;
  pinned: boolean;
  gatewayUrl: string;
} {
  return {
    stored: storage.has(hash),
    pinned: pinnedHashes.has(hash),
    gatewayUrl: getGatewayUrl(hash),
  };
}
