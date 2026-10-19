/**
 * Tests for lib/ipfsStore — #1188 verified content identifiers
 *
 * Verifies:
 *   • uploadJSON / uploadFile derive deterministic CIDv1 identifiers.
 *   • The same payload always produces the same CID (content-addressing).
 *   • Different payloads produce different CIDs.
 *   • CIDs start with "b" (multibase base32lower prefix) — not "Qm" pseudo-hashes.
 *   • Uploaded content can be retrieved and the returned data matches.
 *   • getGatewayUrl and getStorageStatus still work with the new CID format.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  uploadJSON,
  uploadFile,
  retrieve,
  pinHash,
  getGatewayUrl,
  getStorageStatus,
} from "./ipfsStore";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("NEXT_PUBLIC_IPFS_GATEWAY", "");
});

describe("#1188 content-addressed CID derivation", () => {
  it("uploadJSON returns a CIDv1 starting with 'b', not 'Qm'", async () => {
    const hash = await uploadJSON({ title: "GateDelay market", outcome: "delayed" });
    expect(hash).toMatch(/^b[a-z2-7]+$/);
    expect(hash).not.toMatch(/^Qm/);
  });

  it("uploadFile returns a CIDv1 starting with 'b'", async () => {
    const hash = await uploadFile("hello world", "test.txt");
    expect(hash).toMatch(/^b[a-z2-7]+$/);
  });

  it("same JSON payload always produces the same CID (deterministic)", async () => {
    const payload = { market: "AA123", outcome: "on-time" };
    const hash1 = await uploadJSON(payload);
    const hash2 = await uploadJSON(payload);
    expect(hash1).toBe(hash2);
  });

  it("same file content always produces the same CID (deterministic)", async () => {
    const hash1 = await uploadFile("flight data", "data.txt");
    const hash2 = await uploadFile("flight data", "data.txt");
    expect(hash1).toBe(hash2);
  });

  it("different JSON payloads produce different CIDs", async () => {
    const hash1 = await uploadJSON({ a: 1 });
    const hash2 = await uploadJSON({ a: 2 });
    expect(hash1).not.toBe(hash2);
  });

  it("different file contents produce different CIDs", async () => {
    const hash1 = await uploadFile("content A", "file.txt");
    const hash2 = await uploadFile("content B", "file.txt");
    expect(hash1).not.toBe(hash2);
  });

  it("CID is long enough to encode a full SHA-256 digest (≥ 50 chars after 'b')", async () => {
    const hash = await uploadJSON({ x: 1 });
    // base32 of 37 bytes (5-byte prefix + 32-byte digest) = ceil(37*8/5) = 60 chars
    expect(hash.length).toBeGreaterThanOrEqual(50);
  });
});

describe("retrieve — round-trip", () => {
  it("retrieves the exact data that was uploaded", async () => {
    const payload = { title: "round-trip", outcome: "cancelled" };
    const hash = await uploadJSON(payload);
    const result = await retrieve(hash);
    expect(result).toEqual(payload);
  });

  it("throws for an unknown hash", async () => {
    await expect(retrieve("bnotahash")).rejects.toThrow(/not found/i);
  });
});

describe("pinHash", () => {
  it("pins an existing hash and reflects in getStorageStatus", async () => {
    const hash = await uploadJSON({ pinTest: true });
    await pinHash(hash, "my-pin");
    const status = getStorageStatus(hash);
    expect(status.stored).toBe(true);
    expect(status.pinned).toBe(true);
  });

  it("throws for an unknown hash", async () => {
    await expect(pinHash("bunknown")).rejects.toThrow(/not found/i);
  });
});

describe("getGatewayUrl", () => {
  it("constructs a public gateway URL from a CIDv1", async () => {
    const hash = await uploadJSON({ gateway: "test" });
    const url = getGatewayUrl(hash);
    expect(url).toMatch(/^https:\/\/gateway\.pinata\.cloud\/ipfs\/b/);
    expect(url).toContain(hash);
  });

  it("throws on empty hash", () => {
    expect(() => getGatewayUrl("")).toThrow();
  });
});

describe("getStorageStatus", () => {
  it("returns stored=true, pinned=true for a freshly uploaded hash", async () => {
    const hash = await uploadJSON({ status: "check" });
    const status = getStorageStatus(hash);
    expect(status.stored).toBe(true);
    expect(status.pinned).toBe(true);
    expect(status.gatewayUrl).toContain(hash);
  });

  it("returns stored=false, pinned=false for an unknown hash", () => {
    const status = getStorageStatus("bunknownhash");
    expect(status.stored).toBe(false);
    expect(status.pinned).toBe(false);
  });
});

describe("production gateway guard", () => {
  it("throws when a localhost gateway is configured in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_IPFS_GATEWAY", "http://localhost:8080/ipfs/");

    const hash = await uploadJSON({ prod: true });
    expect(() => getGatewayUrl(hash)).toThrow(/localhost/i);
  });
});
