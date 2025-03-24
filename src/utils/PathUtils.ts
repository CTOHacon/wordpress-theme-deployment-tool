import path from 'path';

/**
 * Нормализует путь, заменяя системный разделитель на "/" (унификация путей для Windows и Unix-систем).
 * @param filePath Путь для нормализации
 * @returns Нормализованный путь
 */
export function normalizePath(filePath: string): string {
    return filePath.split(path.sep).join('/');
}