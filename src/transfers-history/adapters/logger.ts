enum CliColor {
  Reset = "\x1b[0m",
  FgGreen = "\x1b[32m",
}

export class Logger {
  static debug(caller: string, message: string) {
    if (process.env.LOG_LEVEL === "debug") {
      console.debug(`${new Date().toISOString()} - `, CliColor.FgGreen, caller, CliColor.Reset, message);
    }
  }
}
