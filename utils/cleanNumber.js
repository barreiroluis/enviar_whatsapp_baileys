export function cleanNumber(number) {
  if (!number) return null;

  // Ya es JID válido
  if (number.endsWith("@s.whatsapp.net") || number.endsWith("@g.us")) {
    return number;
  }

  // Limpiar solo dígitos
  const clean = number.replace(/\D/g, "");

  if (!clean) return null;

  return `${clean}@s.whatsapp.net`;
}
