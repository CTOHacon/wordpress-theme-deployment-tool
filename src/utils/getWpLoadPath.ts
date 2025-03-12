import path from "path";
import type { Config } from "../config/ConfigService";

/**
 * Вычисляет абсолютный путь к файлу wp-load.php на основе параметра local_theme_path.
 * Предполагается, что структура WordPress стандартная:
 * 
 *  / (WordPress root)
 *      wp-load.php
 *      wp-content/
 *          themes/
 *              ваша_тема/
 *
 * От папки темы нужно подняться на три уровня вверх, чтобы попасть в корень.
 *
 * @param config Конфигурация, содержащая параметр local_theme_path
 * @returns Абсолютный путь к wp-load.php
 */
export function getWpLoadPath(config: Config): string {
    // Получаем абсолютный путь к папке темы
    const themeAbsolutePath = path.resolve(config.local_theme_path);
    // Поднимаемся на 3 уровня вверх: из вашей_тема -> themes -> wp-content -> WP root
    const wpLoadPath = path.resolve(themeAbsolutePath, "..", "..", "..", "wp-load.php");
    return wpLoadPath;
}