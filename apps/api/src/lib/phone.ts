// Uzbekistan mobile numbers: +998 followed by 9 digits.

const UZ_PHONE = /^\+998\d{9}$/;

/**
 * Normalizes user input to E.164 (+998XXXXXXXXX).
 * Accepts "+998 90 123-45-67", "998901234567", "901234567". Returns null if invalid.
 */
export function normalizeUzPhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  let full: string;
  if (digits.length === 9) full = `+998${digits}`;
  else if (digits.length === 12 && digits.startsWith('998')) full = `+${digits}`;
  else return null;
  return UZ_PHONE.test(full) ? full : null;
}
