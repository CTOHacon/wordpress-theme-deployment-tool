import type { DeploymentConfig as BaseDeploymentConfig, Config } from "./ConfigService";

// Extend the base interface to allow adding additional properties if needed
export interface DeploymentConfig extends BaseDeploymentConfig { }

/**
 * Service for working with deploy command configuration.
 * Merges values from config.json with a set of default values.
 */
export class DeploymentConfigService {
    /**
     * Returns the final deploy configuration, merging defaults with data from config.json.
     * @param config Main configuration loaded via ConfigService
     * @returns Deploy configuration object
     */
    public static getDeploymentConfig(config: Config): DeploymentConfig {
        return {
            steps: {
                ...config.deployment?.steps
            }
        };
    }
}