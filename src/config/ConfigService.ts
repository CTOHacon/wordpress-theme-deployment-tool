import { promises as fs } from "fs";
import path from "path";
import type { ConnectConfig } from "ssh2";

// Интерфейс для конфигурации деплоя, определяющий команды для отдельных шагов
export interface DeploymentConfig {
    steps: Record<string, string>;
}

export interface Config {
    ssh: ConnectConfig;
    remote_theme_path: string;
    local_theme_path: string;
    exclude: string[];
    deployment?: DeploymentConfig;
}

export class ConfigService {
    /**
     * Загружает конфигурацию из файла и валидирует её
     * @param configPath Путь к файлу конфигурации (по умолчанию "config.json")
     * @returns Объект с конфигурационными данными
     * @throws Если загрузка или валидация не проходит
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
     * Валидирует загруженную конфигурацию
     * @param config Объект, полученный из файла конфигурации
     * @returns Приведённый к типу Config объект
     * @throws Если данные не соответствуют ожидаемому формату
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
        // Если присутствует раздел deployment, проверяем его структуру
        if (config.deployment) {
            if (typeof config.deployment !== "object" || !config.deployment.steps || typeof config.deployment.steps !== "object") {
                throw new Error("Поле 'deployment' должно быть объектом с полем 'steps'");
            }
        }
        return config as Config;
    }
}