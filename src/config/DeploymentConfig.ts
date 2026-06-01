import type { DeploymentConfig as BaseDeploymentConfig, Config } from "./ConfigService";

// Расширяем базовый интерфейс, чтобы при необходимости добавить дополнительные свойства
export interface DeploymentConfig extends BaseDeploymentConfig { }

/**
 * Сервис для работы с конфигурацией команд деплоя.
 * Объединяет значения из config.json с набором значений по умолчанию.
 */
export class DeploymentConfigService {
    /**
     * Возвращает итоговую конфигурацию для деплоя, объединяя дефолтные значения с данными из config.json
     * @param config Основная конфигурация, загруженная через ConfigService
     * @returns Объект конфигурации деплоя
     */
    public static getDeploymentConfig(config: Config): DeploymentConfig {
        return {
            steps: {
                ...config.deployment?.steps
            }
        };
    }
}