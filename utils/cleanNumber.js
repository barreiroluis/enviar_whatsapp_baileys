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

  if (value.endsWith("@lid")) {
    const digits = jidToPhone(value);
    return digits ? `${digits}@lid` : null;
  }

  const digits = jidToPhone(value);
  if (!digits) return null;

  return `${digits}@s.whatsapp.net`;
}

export function toCrmJid(numberOrJid) {
  if (!numberOrJid) return null;

  const value = String(numberOrJid).trim();

  if (value.endsWith("@lid")) {
    const digits = jidToPhone(value);
    return digits ? `${digits}@lid` : null;
  }

  const digits = jidToPhone(value);
  if (!digits) return null;
  return `${digits}@c.us`;
}

// Misma regla de contacto que include/celular_cliente.php en Cuota Fácil.
export function normalizeCustomerPhone(value) {
  if (typeof value !== "string" || !/^\+?[0-9 ()-]+$/.test(value.trim())) {
    return null;
  }
  const number = value.replace(/\D/g, "");
  if (!/^[1-9][0-9]{9,14}$/.test(number)) return null;

  let national = number;
  if (number.startsWith("54")) {
    if (!/^549?[1-3][0-9]{9}$/.test(number)) return null;
    national = number.slice(number.length === 13 ? 3 : 2);
  }

  const subscriber = national.slice(-8);
  if (/^([0-9])\1{7}$/.test(subscriber)
    || "01234567890123456789".includes(subscriber)
    || "98765432109876543210".includes(subscriber)) {
    return null;
  }
  return number;
}
