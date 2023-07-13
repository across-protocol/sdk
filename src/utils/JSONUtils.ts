/**
 * This function converts a JSON string into a JSON object. The caveat is that if
 * the parser detects a number, it will convert it to a string and floor it to
 * an integer. This function will not throw but instead return an undefined value
 * if the JSON string is invalid.
 * @param jsonString The JSON string to parse
 * @returns The parsed JSON object or undefined if the JSON string is invalid
 */
export function parseJSONWithNumericString(jsonString: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(jsonString, (_key, value) => {
      if (typeof value === "number") {
        return String(Math.floor(value));
      }
      return value;
    });
  } catch (e) {
    return undefined;
  }
}
