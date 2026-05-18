import { verify } from "node:crypto";
import { publicKeyObjectFromRaw } from "../identity/keypair.js";

// =============================================================================
// Registry signature verification (#421)
// =============================================================================
//
// Ed25519 detached-signature verify wrapper. Used by `foreman registry update`
// to confirm the fetched `registry.json` was actually signed by the
// upstream maintainer (whose pinned public key the user configured).
//
// Signature format: hex-encoded 64-byte Ed25519 signature over the raw
// bytes of `registry.json`. The server hosts the registry JSON at one URL
// and the detached signature (`registry.json.sig`) at a sibling URL.
//
// Why detached + hex rather than tarball + DER:
//  - Easier to host (two static files, no archive format negotiation)
//  - Easier to inspect (`curl registry.json.sig` returns a readable hex)
//  - Easier to test (no tar dependency)
//  - Signature can be regenerated independently of the content delivery
//    pipeline (signing happens once, mirroring is plain HTTP)

export interface SignatureVerifyResult {
  ok: boolean;
  /** Free-text reason when ok=false. Suitable for CLI surfacing. */
  reason?: string;
}

/**
 * Verify a hex-encoded Ed25519 signature over the given body bytes.
 * Returns ok=false (rather than throwing) so the CLI can show a clean
 * error + actionable hint without try/catch noise.
 */
export function verifyRegistrySignature(opts: {
  body: Buffer;
  signatureHex: string;
  publicKeyHex: string;
}): SignatureVerifyResult {
  const { body, signatureHex, publicKeyHex } = opts;

  // Validate hex shapes up-front so we surface the actual error (bad
  // pubkey vs. bad sig vs. content mismatch) instead of an opaque
  // Node error.
  const sig = parseHex(signatureHex.trim(), 64);
  if (!sig) {
    return {
      ok: false,
      reason: `signature is not 64 bytes of hex (got ${signatureHex.trim().length} chars)`,
    };
  }
  const pub = parseHex(publicKeyHex.trim(), 32);
  if (!pub) {
    return {
      ok: false,
      reason: `public key is not 32 bytes of hex (got ${publicKeyHex.trim().length} chars)`,
    };
  }

  let publicKey;
  try {
    publicKey = publicKeyObjectFromRaw(pub);
  } catch (err) {
    return {
      ok: false,
      reason: `failed to load public key: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    // Node's crypto.verify for Ed25519 takes `null` for the algorithm —
    // the algorithm is determined by the key type.
    const ok = verify(null, body, publicKey, sig);
    if (!ok) {
      return {
        ok: false,
        reason:
          "signature did not verify — either the registry content was tampered with or the wrong public key is configured",
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `verify threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function parseHex(s: string, expectedBytes: number): Buffer | null {
  if (s.length !== expectedBytes * 2) return null;
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  return Buffer.from(s, "hex");
}
