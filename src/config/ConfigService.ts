import { promises as fs } from "fs";
import path from "path";
import type { ConnectConfig } from "ssh2";

// Interface for deploy configuration, defining commands for individual steps
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
     * Loads configuration from a file and validates it.
     * @param configPath Path to the configuration file (default "config.json")
     * @returns Configuration data object
     * @throws If loading or validation fails
     */
    public static async loadConfig(configPath: string = "config.json"): Promise<Config> {
        try {
            const absolutePath = path.resolve(configPath);
            const data = await fs.readFile(absolutePath, { encoding: "utf-8" });
            const configObj = JSON.parse(data);
            return this.validateConfig(configObj);
        } catch (error) {
            throw new Error(`Configuration load error: ${error}`);
        }
    }

    /**
     * Validates the loaded configuration.
     * @param config Object obtained from the configuration file
     * @returns Object cast to Config type
     * @throws If the data does not match the expected format
     */
    public static validateConfig(config: any): Config {
        if (typeof config.remote_theme_path !== "string") {
            throw new Error("Field 'remote_theme_path' must be a string");
        }
        if (typeof config.local_theme_path !== "string") {
            throw new Error("Field 'local_theme_path' must be a string");
        }
        if (!Array.isArray(config.exclude)) {
            throw new Error("Field 'exclude' must be an array of strings");
        }
        if (!config.exclude.every((item: any) => typeof item === "string")) {
            throw new Error("All elements in 'exclude' must be strings");
        }
        // If deployment section is present, validate its structure
        if (config.deployment) {
            if (typeof config.deployment !== "object" || !config.deployment.steps || typeof config.deployment.steps !== "object") {
                throw new Error("Field 'deployment' must be an object with a 'steps' field");
            }
        }
        return config as Config;
    }
}