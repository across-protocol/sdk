import winston from "winston";

export class Logger extends winston.Logger {}
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
  logger: winston.Logger | undefined,
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
