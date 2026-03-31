export type FetchHeaders = { [key: string]: unknown };
export type FetchQueryParams = Record<string, unknown>;

const toStringRecord = (headers: FetchHeaders): Record<string, string> => {
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      normalizedHeaders[key] = String(value);
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

export async function fetchJsonWithTimeout<T = unknown>(
  url: string,
  params: FetchQueryParams = {},
  headers: FetchHeaders = {},
  timeout?: number
): Promise<T> {
  const response = await fetch(applyQueryParams(url, params), {
    headers: toStringRecord(headers),
    ...(timeout && timeout > 0 && { signal: AbortSignal.timeout(timeout) }),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errorBody?.error ?? `HTTP ${response.status}: ${response.statusText}`);
  }

  return (await response.json()) as T;
}
