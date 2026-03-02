export const DEFAULT_TIME_ZONE = "America/Argentina/Buenos_Aires";

export function resolveAppTimeZone(env = process.env) {
  const configuredTimeZone = env.TIME?.trim() || "";

  if (configuredTimeZone) {
    return configuredTimeZone;
  }

  return DEFAULT_TIME_ZONE;
}
