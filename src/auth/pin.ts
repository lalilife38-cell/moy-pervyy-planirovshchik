const PIN_PATTERN = /^\d{4}$/;
const HASH_ITERATIONS = 150_000;

export function validatePinFormat(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePinHash(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations: HASH_ITERATIONS,
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPin(pin: string): Promise<{ pinHash: string; pinSalt: string }> {
  if (!validatePinFormat(pin)) throw new TypeError("PIN должен состоять ровно из 4 цифр.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePinHash(pin, salt);
  return { pinHash: bytesToBase64(hash), pinSalt: bytesToBase64(salt) };
}

export async function verifyPin(pin: string, pinHash: string, pinSalt: string): Promise<boolean> {
  if (!validatePinFormat(pin)) return false;
  let expected: Uint8Array;
  let salt: Uint8Array;
  try {
    expected = base64ToBytes(pinHash);
    salt = base64ToBytes(pinSalt);
  } catch {
    return false;
  }
  const actual = await derivePinHash(pin, salt);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
}
