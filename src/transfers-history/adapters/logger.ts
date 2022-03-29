enum CliColor {
  Reset = "\x1b[0m",
  FgGreen = "\x1b[32m",
  FgYellow = "\x1b[33m",
  FgReg = "\x1b[31m",
}

export type LogLevel = "info" | "debug";

export class Logger {
  private currentLevel: LogLevel;

  public constructor(level?: LogLevel) {
    this.currentLevel = level || "info";
  }

  public setLevel(level: LogLevel) {
    this.currentLevel = level;
  }

  public debug(caller: string, message: string) {
    if (this.currentLevel === "debug") {
      console.debug(`${new Date().toISOString()} - `, CliColor.FgYellow, caller, CliColor.Reset, message);
    }
  }

  public info(caller: string, message: string) {
    console.log(`${new Date().toISOString()} - `, CliColor.FgGreen, caller, CliColor.Reset, message);
  }

  public error(caller: string, message: string) {
    console.error(`${new Date().toISOString()} - `, CliColor.FgReg, caller, CliColor.Reset, message);
  }
}
