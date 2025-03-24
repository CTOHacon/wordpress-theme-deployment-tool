import { promises as fs } from 'fs';
import path from 'path';
import { minimatch } from "minimatch";
import { normalizePath } from '../utils/PathUtils';

export interface FileInfo {
    absolutePath: string;
    relativePath: string;
    updateTime: Date;
}

export class FileCollector {
    /**
     * Рекурсивно обходит директорию basePath, собирает файлы за исключением тех,
     * чей нормализованный относительный путь соответствует одному из шаблонов в excludePatterns.
     * @param basePath Путь к корневой директории
     * @param excludePatterns Массив glob-паттернов для исключения файлов/папок
     * @returns Массив объектов FileInfo с информацией о найденных файлах
     */
    public static async collectFiles(
        basePath: string,
        excludePatterns: string[]
    ): Promise<FileInfo[]> {
        const files: FileInfo[] = [];

        // Преобразуем basePath в абсолютный путь относительно process.cwd()
        const absoluteBasePath = path.resolve(basePath);

        // Рекурсивная функция обхода
        const traverse = async (currentPath: string): Promise<void> => {
            const entries = await fs.readdir(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryAbsolutePath = path.join(currentPath, entry.name);
                // Вычисляем относительный путь относительно absoluteBasePath
                const entryRelativePath = normalizePath(
                    path.relative(absoluteBasePath, entryAbsolutePath)
                );

                if (this.shouldExclude(entryRelativePath, excludePatterns)) {
                    continue;
                }

                if (entry.isDirectory()) {
                    await traverse(entryAbsolutePath);
                } else if (entry.isFile()) {
                    const stats = await fs.stat(entryAbsolutePath);
                    files.push({
                        absolutePath: entryAbsolutePath,
                        relativePath: entryRelativePath,
                        updateTime: stats.mtime,
                    });
                }
            }
        };

        await traverse(absoluteBasePath);
        return files;
    }

    /**
     * Копирует файлы из массива FileInfo в указанную директорию outputPath,
     * сохраняя исходную структуру папок и время последнего изменения.
     * @param files Массив объектов FileInfo, полученный из collectFiles
     * @param outputPath Путь к директории, куда будут скопированы файлы
     */
    public static async copyFilesToOutput(
        files: FileInfo[],
        outputPath: string
    ): Promise<void> {
        for (const file of files) {
            const targetPath = path.join(outputPath, file.relativePath);
            // Создаем необходимые директории
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.copyFile(file.absolutePath, targetPath);
            // Устанавливаем время последнего изменения, равное оригинальному
            await fs.utimes(targetPath, new Date(), file.updateTime);
        }
    }

    /**
     * Проверяет, соответствует ли нормализованный относительный путь файлу одному из исключающих паттернов.
     * @param filePath Нормализованный относительный путь файла или директории
     * @param excludePatterns Массив glob-паттернов для исключения
     * @returns true, если файл должен быть исключен, иначе false
     */
    private static shouldExclude(filePath: string, excludePatterns: string[]): boolean {
        return excludePatterns.some(pattern => minimatch(filePath, pattern, { dot: true }));
    }
}