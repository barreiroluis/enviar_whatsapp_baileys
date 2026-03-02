export const DEFAULT_TIME_ZONE = "America/Argentina/Buenos_Aires";

const GENERIC_UTC_TIME_ZONES = new Set(["UTC", "Etc/UTC"]);

export function resolveAppTimeZone(env = process.env) {
  const inheritedTimeZone = env.TZ?.trim() || "";

  if (inheritedTimeZone && !GENERIC_UTC_TIME_ZONES.has(inheritedTimeZone)) {
    return inheritedTimeZone;
  }

  return DEFAULT_TIME_ZONE;
}
