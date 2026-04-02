export type FetchHeaders = { [key: string]: unknown };
export type FetchQueryParams = Record<string, unknown>;

const toStringRecord = (headers: FetchHeaders): Record<string, string> => {
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      normalizedHeaders[key.toLowerCase()] = String(value);
    }
  }
  return normalizedHeaders;
};

const applyQueryParams = (url: string, params: FetchQueryParams): string => {
  if (Object.keys(params).length === 0) return url;

  const parsedUrl = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      parsedUrl.searchParams.append(key, String(value));
    }
  }

  return parsedUrl.toString();
};

async function baseFetch<T = unknown>(
  url: string,
  method: string,
  body: string | undefined,
  params: FetchQueryParams,
  headers: FetchHeaders,
  timeout?: number,
  responseType: "json" | "text" = "json"
): Promise<T> {
  const fullUrl = applyQueryParams(url, params);
  const response = await fetch(fullUrl, {
    method,
    body,
    headers: toStringRecord(headers),
    ...(timeout && timeout > 0 && { signal: AbortSignal.timeout(timeout) }),
  });

  // Read body as text first — body can only be consumed once, and we need
  // the raw text for meaningful error messages if JSON parsing fails.
  const text = await response.text();

  if (!response.ok) {
    let errorMessage: string | undefined;
    try {
      errorMessage = (JSON.parse(text) as { error?: string })?.error;
    } catch {
      // Response body wasn't JSON — fall through to default message.
    }
    throw new Error(errorMessage ?? `HTTP ${response.status}: ${response.statusText}`);
  }

  if (responseType === "text") {
    return text as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = response.headers.get("content-type") ?? "unknown";
    throw new Error(
      `Expected JSON response from ${fullUrl} but received content-type: ${contentType} (body: ${text.slice(0, 256)})`
    );
  }
}

export function fetchWithTimeout<T = unknown>(
  url: string,
  params: FetchQueryParams = {},
  headers: FetchHeaders = {},
  timeout?: number,
  responseType: "json" | "text" = "json"
): Promise<T> {
  return baseFetch<T>(url, "GET", undefined, params, headers, timeout, responseType);
}

export function postWithTimeout<T = unknown>(
  url: string,
  body: unknown,
  params: FetchQueryParams = {},
  headers: FetchHeaders = {},
  timeout?: number,
  responseType: "json" | "text" = "json"
): Promise<T> {
  return baseFetch<T>(
    url,
    "POST",
    JSON.stringify(body),
    params,
    { "Content-Type": "application/json", ...headers },
    timeout,
    responseType
  );
}
