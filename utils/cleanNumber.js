const MIN_PHONE_LENGTH = 8;
const MAX_PHONE_LENGTH = 15;

function isValidPhoneDigits(digits) {
  return (
    typeof digits === "string" &&
    digits.length >= MIN_PHONE_LENGTH &&
    digits.length <= MAX_PHONE_LENGTH
  );
}

export function jidToPhone(numberOrJid) {
  if (!numberOrJid) return null;

  const value = String(numberOrJid).trim();
  const localPart = value.includes("@") ? value.split("@")[0] : value;
  const digits = localPart.replace(/\D/g, "");

  if (!isValidPhoneDigits(digits)) return null;

  return digits;
}

export function cleanNumber(number) {
  if (!number) return null;

  const value = String(number).trim();

  // Solo permitimos números de usuario, no grupos.
  if (value.endsWith("@g.us")) {
    return null;
  }

  if (value.endsWith("@s.whatsapp.net")) {
    const digits = jidToPhone(value);
    return digits ? `${digits}@s.whatsapp.net` : null;
  }

  const digits = jidToPhone(value);
  if (!digits) return null;

  return `${digits}@s.whatsapp.net`;
}
