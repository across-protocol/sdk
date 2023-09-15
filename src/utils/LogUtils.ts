import { Logger } from "winston";

export type DefaultLogLevels = "debug" | "info" | "warn" | "error";

type LogParamType = {
  level: DefaultLogLevels;
  message: string;
  at: {
    location: string;
    function: string;
  };
  data?: Record<string | number, unknown>;
};

export function formattedLog(
  logger: Logger | undefined,
  { level, message, at: { location, function: fnName }, data }: LogParamType
): void {
  if (logger) {
    logger[level]({
      at: `${location}#${fnName}`,
      message,
      ...data,
    });
  }
}

/**
 * Asserts the truth of a condition. If the condition is false, an error is thrown with the provided message.
 * @param condition The condition to assert.
 * @param message The message to throw if the condition is false.
 * @throws Error if the condition is false.
 */
export function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}
