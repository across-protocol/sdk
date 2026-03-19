export interface LoggingFunction {
  (data: { at: string; message: string; [key: string]: unknown }): void;
}

export interface LoggerLike {
  debug: LoggingFunction;
  info: LoggingFunction;
  warn: LoggingFunction;
  error: LoggingFunction;
}
