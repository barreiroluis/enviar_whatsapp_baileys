const MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function getExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split("/").pop() || "";
    const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
  } catch {
    const cleanUrl = String(url || "").split("?")[0];
    const match = cleanUrl.toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
  }
}

export function getMimeTypeFromUrl(url) {
  return MIME_BY_EXTENSION[getExtensionFromUrl(url)] || "";
}

export function getMediaTypeFromMime(mimeType = "") {
  const mime = String(mimeType).toLowerCase().split(";")[0].trim();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (
    mime === "application/pdf" ||
    mime === "application/msword" ||
    mime === "application/vnd.ms-excel" ||
    mime.includes("officedocument") ||
    mime === "text/html"
  ) {
    return "document";
  }

  return null;
}

export function getMediaTypeFromUrl(url) {
  return getMediaTypeFromMime(getMimeTypeFromUrl(url));
}

export function getFileNameFromUrl(url) {
  try {
    const name = new URL(url).pathname.split("/").pop();
    return name || "archivo";
  } catch {
    const cleanUrl = String(url || "").split("?")[0];
    return cleanUrl.split("/").pop() || "archivo";
  }
}

function getFileNameFromContentDisposition(value = "") {
  const header = String(value || "");
  const utfMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch) {
    try {
      return decodeURIComponent(utfMatch[1].trim());
    } catch {
      return utfMatch[1].trim();
    }
  }

  const match = header.match(/filename="?([^";]+)"?/i);
  return match ? match[1].trim() : "";
}

async function fetchMediaHeaders(url) {
  if (typeof fetch !== "function") return {};
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    return {
      contentType: response.headers.get("content-type") || "",
      contentDisposition: response.headers.get("content-disposition") || "",
    };
  } catch {
    return {};
  }
}

export async function resolveMediaFromUrl(url, options = {}) {
  const explicitType = String(options.mediaType || "").trim();
  const explicitMimeType = String(options.mimetype || "").trim();
  const explicitFileName = String(options.fileName || "").trim();

  let mimetype = explicitMimeType || getMimeTypeFromUrl(url);
  let mediaType = explicitType || getMediaTypeFromMime(mimetype) || getMediaTypeFromUrl(url);
  let fileName = explicitFileName || getFileNameFromUrl(url);

  if (!mediaType || !mimetype || !explicitFileName) {
    const headers = await fetchMediaHeaders(url);
    if (!mimetype && headers.contentType) {
      mimetype = headers.contentType.split(";")[0].trim();
    }
    if (!mediaType && mimetype) {
      mediaType = getMediaTypeFromMime(mimetype);
    }
    if (!explicitFileName && headers.contentDisposition) {
      fileName = getFileNameFromContentDisposition(headers.contentDisposition) || fileName;
    }
  }

  if (mediaType === "document" && (!fileName || fileName === "archivo")) {
    const extension = mimetype === "application/pdf" ? "pdf" : "bin";
    fileName = `archivo.${extension}`;
  }

  return {
    mediaType,
    mimetype,
    fileName,
  };
}
