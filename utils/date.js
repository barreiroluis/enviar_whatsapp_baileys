import moment from "moment-timezone";
import { resolveAppTimeZone } from "./timezone.js";

export function getCurrentDateTime() {
  const timeZone = resolveAppTimeZone();
  return moment.tz(timeZone).format("YYYY-MM-DD HH:mm:ss");
}
