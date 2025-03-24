import chalk from "chalk";

enum LogLevel {
    INFO = "INFO",
    DEBUG = "DEBUG",
    WARN = "WARN",
    ERROR = "ERROR",
    UPLOAD = "UPLOAD",
    UPDATE = "UPDATE",
    DELETE = "DELETE",
    SUCCESS = "SUCCESS",
}

export default class Logger {
    /**
     * Форматирует сообщение с использованием заданного уровня логирования.
     * @param level Уровень логирования.
     * @param message Сообщение для вывода.
     * @returns Отформатированная строка.
     */
    private static formatMessage(level: LogLevel, message: string): string {
        let styledTitle: string;
        switch (level) {
            case LogLevel.INFO:
                styledTitle = chalk.bgBlue.white.bold(` ${level} `);
                break;
            case LogLevel.DEBUG:
                styledTitle = chalk.bgMagenta.white.bold(` ${level} `);
                break;
            case LogLevel.WARN:
                styledTitle = chalk.bgYellow.black.bold(` ${level} `);
                break;
            case LogLevel.ERROR:
                styledTitle = chalk.bgRed.white.bold(` ${level} `);
                break;
            case LogLevel.UPLOAD:
                styledTitle = chalk.bgGreen.white.bold(` ${level} `);
                break;
            case LogLevel.UPDATE:
                styledTitle = chalk.bgYellow.black.bold(` ${level} `);
                break;
            case LogLevel.DELETE:
                styledTitle = chalk.bgRed.white.bold(` ${level} `);
                break;
            case LogLevel.SUCCESS:
                styledTitle = chalk.bgGreen.white.bold(` ${level} `);
                break;
            default:
                styledTitle = chalk.bgMagenta.white.bold(" LOG ");
        }
        return `${styledTitle} ${message}`;
    }

    public static info(message: string): void {
        console.log(this.formatMessage(LogLevel.INFO, message));
    }

    public static debug(message: string): void {
        console.debug(this.formatMessage(LogLevel.DEBUG, message));
    }

    public static warn(message: string): void {
        console.warn(this.formatMessage(LogLevel.WARN, message));
    }

    public static error(message: string): void {
        console.error(this.formatMessage(LogLevel.ERROR, message));
    }

    public static success(message: string): void {
        console.log(this.formatMessage(LogLevel.SUCCESS, message));
    }

    /**
     * Выводит сообщение с произвольным уровнем логирования.
     * Если переданный уровень не соответствует предопределённым, используется DEBUG.
     * @param level Уровень логирования или тип операции.
     * @param message Сообщение для вывода.
     */
    public static log(level: string, message: string): void {
        const validLevels = Object.values(LogLevel);
        const logLevel: LogLevel = validLevels.includes(level as LogLevel)
            ? (level as LogLevel)
            : LogLevel.DEBUG;
        console.log(this.formatMessage(logLevel, message));
    }
}