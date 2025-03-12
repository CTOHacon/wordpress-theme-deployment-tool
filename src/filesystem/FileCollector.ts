import { promises as fs } from "fs";
import path from "path";
import { minimatch } from "minimatch";

// Интерфейс для описания файла
export interface FileInfo {
    absolutePath: string;
    relativePath: string;
    updateTime: Date;
}

export class FileCollector {
    /**
     * Рекурсивно обходит директорию basePath, собирает файлы, за исключением тех,
     * чьи относительные пути содержат один из паттернов в excludePatterns.
     * @param basePath Путь к корневой директории
     * @param excludePatterns Массив строк-паттернов для исключения файлов/папок
     * @returns Массив объектов FileInfo с информацией о найденных файлах
     */
    public static async collectFiles(
        basePath: string,
        excludePatterns: string[]
    ): Promise<FileInfo[]> {
        const files: FileInfo[] = [];

        // Рекурсивная функция обхода
        const traverse = async (currentPath: string, relativePath: string) => {
            const entries = await fs.readdir(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(currentPath, entry.name);
                const entryRelativePath = path.join(relativePath, entry.name);

                // Если текущая папка или файл удовлетворяет паттерну исключения, пропускаем
                if (this.shouldExclude(entryRelativePath, excludePatterns)) {
                    continue;
                }

                if (entry.isDirectory()) {
                    await traverse(entryPath, entryRelativePath);
                } else if (entry.isFile()) {
                    const stats = await fs.stat(entryPath);
                    files.push({
                        absolutePath: entryPath,
                        relativePath: entryRelativePath,
                        updateTime: stats.mtime
                    });
                }
            }
        };

        await traverse(basePath, "");
        return files;
    }

    /**
     * Копирует файлы из массива files в директорию outputPath, сохраняя структуру папок
     * и устанавливая время последнего изменения, равное исходному.
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
     * Проверяет, нужно ли исключить файл/папку, если его относительный путь содержит
     * один из заданных паттернов.
     * @param filePath Относительный путь файла или директории
     * @param excludePatterns Массив паттернов
     * @returns true, если нужно исключить, иначе false
     */
    private static shouldExclude(
        filePath: string,
        excludePatterns: string[]
    ): boolean {
        return excludePatterns.some(pattern => minimatch(filePath, pattern, { dot: true }));
    }
}