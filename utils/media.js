export function getMediaTypeFromUrl(url) {
  const lower = url.toLowerCase();

  if (lower.match(/\.(jpg|jpeg|png|webp)$/)) return "image";
  if (lower.match(/\.(mp4|mov|avi|mkv)$/)) return "video";
  if (lower.match(/\.(mp3|ogg|wav)$/)) return "audio";
  if (lower.match(/\.(pdf|doc|docx|xls|xlsx)$/)) return "document";

  return null;
}

export function getFileNameFromUrl(url) {
  try {
    const cleanUrl = url.split("?")[0]; // quita query params
    const name = cleanUrl.split("/").pop();
    return name || "archivo";
  } catch {
    return "archivo";
  }
}
