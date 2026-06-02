import { AppError } from "./http";

export interface TelegramStoredFile {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramPhotoSize extends TelegramStoredFile {
  width?: number;
  height?: number;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
}

interface TelegramMessage {
  document?: TelegramStoredFile;
  sticker?: TelegramStoredFile;
  animation?: TelegramStoredFile;
  video?: TelegramStoredFile;
  audio?: TelegramStoredFile;
  voice?: TelegramStoredFile;
  video_note?: TelegramStoredFile;
  photo?: TelegramPhotoSize[];
}

interface TelegramFileInfo {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

export async function uploadDocumentToTelegram(params: {
  botToken: string;
  chatId: string;
  file: Blob;
  fileName: string;
}): Promise<TelegramStoredFile> {
  const formData = new FormData();
  formData.set("chat_id", params.chatId);
  formData.set("document", params.file, params.fileName);
  formData.set("disable_notification", "true");

  const response = await fetch(telegramApiUrl(params.botToken, "sendDocument"), {
    method: "POST",
    body: formData
  });
  const body = await readTelegramJson<TelegramMessage>(response);

  if (!response.ok || !body.ok) {
    throw telegramError("TelegramUploadFailed", "Telegram sendDocument failed", response.status, body);
  }

  const uploadedFile = extractUploadedFile(body.result);

  if (!uploadedFile) {
    throw new AppError(502, "TelegramUploadFailed", "Telegram response did not include a supported file_id");
  }

  return uploadedFile;
}

export async function getTelegramFileUrl(params: {
  botToken: string;
  fileId: string;
}): Promise<string> {
  const url = new URL(telegramApiUrl(params.botToken, "getFile"));
  url.searchParams.set("file_id", params.fileId);

  const response = await fetch(url.toString());
  const body = await readTelegramJson<TelegramFileInfo>(response);

  if (!response.ok || !body.ok) {
    throw telegramError("TelegramFileLookupFailed", "Telegram getFile failed", response.status, body);
  }

  if (!body.result?.file_path) {
    throw new AppError(502, "TelegramFileLookupFailed", "Telegram response did not include file_path");
  }

  return telegramFileUrl(params.botToken, body.result.file_path);
}

export async function fetchTelegramFile(params: {
  fileUrl: string;
  rangeHeader: string | null;
}): Promise<Response> {
  const headers = new Headers();

  if (params.rangeHeader) {
    headers.set("Range", params.rangeHeader);
  }

  const response = await fetch(params.fileUrl, { headers });

  if (!response.ok && response.status !== 206) {
    throw new AppError(
      response.status === 404 ? 404 : 502,
      "TelegramFileDownloadFailed",
      `Telegram file download failed with status ${response.status}`
    );
  }

  return response;
}

function telegramApiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

function telegramFileUrl(botToken: string, filePath: string): string {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://api.telegram.org/file/bot${botToken}/${encodedPath}`;
}

function extractUploadedFile(message: TelegramMessage | undefined): TelegramStoredFile | undefined {
  if (!message) {
    return undefined;
  }

  const directCandidates = [
    message.document,
    message.sticker,
    message.animation,
    message.video,
    message.audio,
    message.voice,
    message.video_note
  ];

  for (const candidate of directCandidates) {
    if (isTelegramStoredFile(candidate)) {
      return candidate;
    }
  }

  const photo = chooseLargestPhoto(message.photo);

  if (photo) {
    return photo;
  }

  return undefined;
}

function chooseLargestPhoto(photo: TelegramPhotoSize[] | undefined): TelegramPhotoSize | undefined {
  if (!photo?.length) {
    return undefined;
  }

  return photo
    .filter(isTelegramStoredFile)
    .sort((left, right) => photoScore(right) - photoScore(left))[0];
}

function photoScore(photo: TelegramPhotoSize): number {
  return photo.file_size ?? (photo.width ?? 0) * (photo.height ?? 0);
}

function isTelegramStoredFile(value: TelegramStoredFile | undefined): value is TelegramStoredFile {
  return typeof value?.file_id === "string" && value.file_id.length > 0;
}

async function readTelegramJson<T>(response: Response): Promise<TelegramApiResponse<T>> {
  const contentType = response.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      description: `Expected JSON response from Telegram, got ${contentType || "unknown content type"}`
    };
  }

  try {
    return (await response.json()) as TelegramApiResponse<T>;
  } catch {
    return { ok: false, description: "Failed to parse Telegram JSON response" };
  }
}

function telegramError(
  error: string,
  message: string,
  status: number,
  body: TelegramApiResponse<unknown>
): AppError {
  const retryAfter = body.parameters?.retry_after;

  return new AppError(status === 429 ? 429 : 502, error, body.description || message, {
    telegram_status: status,
    telegram_error_code: body.error_code,
    ...(typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter > 0
      ? { telegram_retry_after_seconds: retryAfter }
      : {})
  });
}
