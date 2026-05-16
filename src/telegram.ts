import { AppError } from "./http";

export interface TelegramDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramMessage {
  document?: TelegramDocument;
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
  file: File;
  fileName: string;
}): Promise<TelegramDocument> {
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

  if (!body.result?.document?.file_id) {
    throw new AppError(502, "TelegramUploadFailed", "Telegram response did not include document.file_id");
  }

  return body.result.document;
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
  return new AppError(status >= 400 && status < 500 ? 502 : 502, error, body.description || message, {
    telegram_status: status,
    telegram_error_code: body.error_code
  });
}
