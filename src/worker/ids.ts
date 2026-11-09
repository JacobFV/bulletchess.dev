const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Largest multiple of the alphabet size below 256, for unbiased rejection sampling. */
const LIMIT = 256 - (256 % ALPHABET.length);

/** Unbiased random id from an unambiguous alphabet (no 0/O/1/l/I). */
export function randomId(len = 10): string {
  let out = "";
  const buf = new Uint8Array(len * 2);
  while (out.length < len) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < LIMIT) out += ALPHABET[b % ALPHABET.length];
      if (out.length === len) break;
    }
  }
  return out;
}
