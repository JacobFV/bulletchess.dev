const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Unbiased random id from an unambiguous alphabet (no 0/O/1/l/I). */
export function randomId(len = 10): string {
  const out: string[] = [];
  const buf = new Uint8Array(len * 2);
  while (out.length < len) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 232) out.push(ALPHABET[b % 58]!); // 232 = 4 × 58
      if (out.length === len) break;
    }
  }
  return out.join("");
}
