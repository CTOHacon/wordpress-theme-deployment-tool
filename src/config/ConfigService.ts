import { promises as fs } from "fs";
import path from "path";
import type { ConnectConfig } from "ssh2";

export interface Config {
    ssh: ConnectConfig;
    remote_theme_path: string;
    local_theme_path: string;
    exclude: string[];
}

export class ConfigService {
    /**
     * Загружает конфигурацию из указанного файла и валидирует её.
     * @param configPath Путь к файлу конфигурации (по умолчанию "config.json")
     * @returns Объект с конфигурационными данными
     * @throws Если файл не найден или данные не проходят валидацию
     */
    public static async loadConfig(configPath: string = "config.json"): Promise<Config> {
        try {
            const absolutePath = path.resolve(configPath);
            const data = await fs.readFile(absolutePath, { encoding: "utf-8" });
            const configObj = JSON.parse(data);
            return this.validateConfig(configObj);
        } catch (error) {
            throw new Error(`Ошибка загрузки конфигурации: ${error}`);
        }
    }

    /**
     * Валидирует объект конфигурации.
     * @param config Объект, полученный из файла конфигурации
     * @returns Объект, приведённый к типу Config
     * @throws Если обнаружены несоответствия типов или отсутствуют обязательные поля
     */
    public static validateConfig(config: any): Config {
        if (typeof config.remote_theme_path !== "string") {
            throw new Error("Поле 'remote_theme_path' должно быть строкой");
        }
        if (typeof config.local_theme_path !== "string") {
            throw new Error("Поле 'local_theme_path' должно быть строкой");
        }
        if (!Array.isArray(config.exclude)) {
            throw new Error("Поле 'exclude' должно быть массивом строк");
        }
        if (!config.exclude.every((item: any) => typeof item === "string")) {
            throw new Error("Все элементы в 'exclude' должны быть строками");
        }
        return config as Config;
    }
}