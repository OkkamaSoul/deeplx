/**
 * Core translation query functionality for DeepLX API
 * Handles communication with DeepL API endpoints with retry logic, rate limiting and header sanitation
 */

import {
  DEFAULT_RETRY_CONFIG,
  PAYLOAD_LIMITS,
  REQUEST_TIMEOUT,
} from "./config";
import { API_URL, REQUEST_ALTERNATIVES } from "./const";
import { createErrorResponse } from "./errorHandler";
import {
  generateBrowserFingerprint,
  selectProxy,
  prepareRequestHeaders,
} from "./proxyManager";
import { checkCombinedRateLimit } from "./rateLimit";
import { isRetryableError, RetryOptions, retryWithBackoff } from "./retryLogic";
import {
  Config,
  createStandardResponse,
  RawResponseParams,
  RequestParams,
  ResponseParams,
} from "./types";

/* ---------- helpers (unchanged / lightly refactored) ---------- */

function normalizeLanguageCode(langCode: string) {
  if (!langCode || langCode.toLowerCase() === "auto") {
    return "auto";
  }
  const normalized = langCode.toLowerCase();
  const languageMap: Record<string, string> = {
    chinese: "ZH",
    english: "EN",
    spanish: "ES",
    french: "FR",
    german: "DE",
    italian: "IT",
    japanese: "JA",
    portuguese: "PT",
    russian: "RU",
    dutch: "NL",
    polish: "PL",
    swedish: "SV",
    danish: "DA",
    norwegian: "NB",
    finnish: "FI",
    czech: "CS",
    slovak: "SK",
    slovenian: "SL",
    estonian: "ET",
    latvian: "LV",
    lithuanian: "LT",
    hungarian: "HU",
    romanian: "RO",
    bulgarian: "BG",
    greek: "EL",
    turkish: "TR",
    ukrainian: "UK",
    korean: "KO",
    indonesian: "ID",
  };
  if (languageMap[normalized]) return languageMap[normalized];
  return normalized.toUpperCase();
}

function buildRequestParams(sourceLang = "auto", targetLang = "en") {
  const timestamp = Date.now();
  const randomComponent = Math.floor(Math.random() * 1000000);
  const requestId = Math.floor(
    (timestamp % 100000000) + (randomComponent % 100000000)
  );

  const normalizedSourceLang = normalizeLanguageCode(sourceLang || "auto");
  const normalizedTargetLang = normalizeLanguageCode(targetLang || "en");

  return {
    jsonrpc: "2.0",
    method: "LMT_handle_texts",
    id: requestId,
    params: {
      texts: [{ text: "", requestAlternatives: REQUEST_ALTERNATIVES }],
      timestamp: 0,
      splitting: "newlines",
      lang: {
        source_lang_user_selected: normalizedSourceLang,
        target_lang: normalizedTargetLang,
      },
    },
  };
}

function countLetterI(translateText: string) {
  return (translateText || "").split("i").length - 1;
}

function getTimestamp(letterCount: number) {
  const timestamp = Date.now();
  const safeLetterCount = Math.max(0, letterCount || 0);
  if (safeLetterCount === 0) return timestamp;
  const modValue = safeLetterCount + 1;
  if (modValue <= 0 || modValue > 1000) return timestamp;
  try {
    const modifiedTimestamp = timestamp - (timestamp % modValue) + modValue;
    if (
      modifiedTimestamp > 0 &&
      modifiedTimestamp <= Number.MAX_SAFE_INTEGER &&
      modifiedTimestamp >= timestamp - 1000
    ) {
      return modifiedTimestamp;
    }
  } catch {
    // fallback to original
  }
  return timestamp;
}

function buildRequestBody(data: RequestParams) {
  if (!data || !data.text || typeof data.text !== "string") {
    throw new Error(
      "Invalid request parameters: text is required and must be a string"
    );
  }

  const trimmedText = data.text;
  if (!trimmedText) {
    throw new Error("Invalid request parameters: text cannot be empty");
  }

  const maxTextLength = PAYLOAD_LIMITS.MAX_TEXT_LENGTH;
  if (trimmedText.length > maxTextLength) {
    throw new Error(
      `Text too long. Maximum length is ${maxTextLength} characters to prevent payload size errors.`
    );
  }

  const sourceLang = data.source_lang || "auto";
  const targetLang = data.target_lang || "en";

  const requestData = buildRequestParams(sourceLang, targetLang);
  requestData.params.texts = [
    { text: trimmedText, requestAlternatives: REQUEST_ALTERNATIVES },
  ];

  const letterICount = countLetterI(trimmedText);
  const timestamp = getTimestamp(letterICount);

  if (timestamp <= 0 || !Number.isFinite(timestamp)) {
    throw new Error("Invalid timestamp generated");
  }

  requestData.params.timestamp = timestamp;

  let requestString = JSON.stringify(requestData);
  const requestId = requestData.id;
  if ((requestId + 5) % 29 === 0 || (requestId + 3) % 13 === 0) {
    requestString = requestString.replace('"method":"', '"method" : "');
  } else {
    requestString = requestString.replace('"method":"', '"method": "');
  }

  const payloadSize = new TextEncoder().encode(requestString).length;
  if (payloadSize > PAYLOAD_LIMITS.MAX_REQUEST_SIZE) {
    throw new Error(
      `Request payload too large (${payloadSize} bytes). Maximum allowed is ${PAYLOAD_LIMITS.MAX_REQUEST_SIZE} bytes.`
    );
  }

  return requestString;
}

/* ---------- main query function (uses sanitized headers) ---------- */

async function query(
  params: RequestParams,
  config?: Config & { env?: any }
): Promise<ResponseParams> {
  if (!params?.text) {
    return createStandardResponse(
      400,
      null,
      undefined,
      normalizeLanguageCode(params?.source_lang || "auto"),
      normalizeLanguageCode(params?.target_lang || "en")
    );
  }

  const retryOptions: RetryOptions = {
    ...DEFAULT_RETRY_CONFIG,
    isRetryable: isRetryableError,
  };

  try {
    return await retryWithBackoff(async () => {
      // resolve endpoint (proxy or direct)
      const proxy = config?.env ? await selectProxy(config.env) : null;
      const endpoint = config?.proxyEndpoint ?? proxy?.url ?? API_URL;

      // rate limit check
      if (config?.env) {
        const clientIP = config?.clientIP || "unknown";
        const rateLimitResult = await checkCombinedRateLimit(
          clientIP,
          endpoint,
          config.env
        );
        if (!rateLimitResult.allowed) {
          const error = new Error(rateLimitResult.reason || "Rate limit exceeded");
          (error as any).code = 429;
          throw error;
        }
      }

      const fingerprint = generateBrowserFingerprint();

      const makeRequest = async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        try {
          const requestBody = buildRequestBody(params);

          // build base headers object (plain record)
          const baseHeadersObj: Record<string, string> = {
            "Content-Type": "application/json; charset=utf-8",
            ...fingerprint,
            ...(config?.customHeader || {}),
          };

          // Prepare headers: remove cf-* and other forwarding headers; inject client IP
          const preparedHeaders = prepareRequestHeaders(
            baseHeadersObj,
            config?.clientIP
          );

          const response = await fetch(endpoint, {
            method: "POST",
            headers: preparedHeaders,
            body: requestBody,
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok && response.status === 400) {
            // Only log detailed body when debug mode is enabled
            if ((globalThis as any)?.DEBUG_MODE) {
              console.error(`400 error received. Request body was:`, requestBody);
            }
          }

          return response;
        } catch (error) {
          clearTimeout(timeoutId);
          if (error instanceof Error && error.name === "AbortError") {
            const timeoutError = new Error(
              `Request timeout after ${REQUEST_TIMEOUT / 1000} seconds to ${endpoint}`
            );
            (timeoutError as any).status = 408;
            throw timeoutError;
          }
          throw error;
        }
      };

      const response = await makeRequest();

      if (!response.ok) {
        let errorMessage = `Request failed with status ${response.status}`;
        try {
          const errorText = await response.text();
          if (errorText) errorMessage += `: ${errorText}`;
        } catch {
          // ignore read errors
        }
        const error = new Error(errorMessage);
        (error as any).status = response.status;
        throw error;
      }

      let result: RawResponseParams;
      try {
        result = (await response.json()) as RawResponseParams;
      } catch (parseError) {
        const error = new Error(
          `Failed to parse JSON response from ${endpoint}: ${
            parseError instanceof Error ? parseError.message : String(parseError)
          }`
        );
        (error as any).code = 500;
        throw error;
      }

      if ("error" in result && result.error) {
        const errorCode = (result.error as any).code;
        const errorMessage =
          (result.error as any).message || "Unknown DeepL API error";
        let enhancedMessage = errorMessage;

        switch (errorCode) {
          case 1156049:
            enhancedMessage =
              "Invalid request format detected. This may be caused by: 1) Incorrect JSON-RPC structure, 2) Invalid request ID format, 3) Malformed timestamp, or 4) Unsupported language codes.";
            break;
          case 1042912:
            enhancedMessage = "Too many requests. Please try again later.";
            break;
          case 1042513:
            enhancedMessage = "Request quota exceeded. Please try again later.";
            break;
          case 1042003:
            enhancedMessage = "Invalid authentication. Please check your API configuration.";
            break;
          default:
            enhancedMessage = `DeepL API error: ${errorMessage} (Code: ${errorCode})`;
        }

        const error = new Error(enhancedMessage);
        (error as any).code = errorCode;
        (error as any).originalMessage = errorMessage;
        throw error;
      }

      if (!result.result || !result.result.texts || !result.result.texts.length) {
        const error = new Error("Invalid response structure from DeepL API");
        (error as any).code = 500;
        throw error;
      }

      const translatedText = result.result.texts[0].text;

      return createStandardResponse(
        200,
        translatedText,
        result.id,
        (result.result.lang as string).toUpperCase(),
        normalizeLanguageCode(params.target_lang)
      );
    }, retryOptions);
  } catch (error: any) {
    const errorDetails = createErrorResponse(error, {
      endpoint: config?.proxyEndpoint,
    });

    return createStandardResponse(
      errorDetails.httpStatus,
      null,
      undefined,
      normalizeLanguageCode(params.source_lang || "auto"),
      normalizeLanguageCode(params.target_lang || "en")
    );
  }
}

export { buildRequestBody, normalizeLanguageCode, query };
