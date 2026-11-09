/**
 * Password hashing with PBKDF2-HMAC-SHA256 via WebCrypto (native in workerd, so it does not burn
 * the Worker's CPU budget the way a pure-JS scrypt does). 100 000 iterations is the workerd ceiling.
 * Format: pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>
 */
const ITERATIONS = 100_000;
const enc = new TextEncoder();

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const [alg, iter, salt, expected] = hash.split("$");
  if (alg !== "pbkdf2-sha256" || !iter || !salt || !expected) return false;
  const iterations = Number(iter);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > ITERATIONS) return false;
  const actual = await derive(password, unb64(salt), iterations);
  const exp = unb64(expected);
  if (actual.length !== exp.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ exp[i]!;
  return diff === 0;
}
