import moment from "moment-timezone";

export function getCurrentDateTime() {
  const timeZone = process.env.TZ || "UTC";
  return moment.tz(timeZone).format("YYYY-MM-DD HH:mm:ss");
}
