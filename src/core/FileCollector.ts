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
     * Recursively traverses the basePath directory, collecting files except those
     * whose normalized relative path matches one of the excludePatterns.
     * @param basePath Path to the root directory
     * @param excludePatterns Array of glob patterns to exclude files/folders
     * @returns Array of FileInfo objects with information about found files
     */
    public static async collectFiles(
        basePath: string,
        excludePatterns: string[]
    ): Promise<FileInfo[]> {
        const files: FileInfo[] = [];

        // Convert basePath to absolute path relative to process.cwd()
        const absoluteBasePath = path.resolve(basePath);

        // Recursive traversal function
        const traverse = async (currentPath: string): Promise<void> => {
            const entries = await fs.readdir(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryAbsolutePath = path.join(currentPath, entry.name);
                // Calculate relative path from absoluteBasePath
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
     * Copies files from the FileInfo array to the specified outputPath directory,
     * preserving the original folder structure and modification time.
     * @param files Array of FileInfo objects from collectFiles
     * @param outputPath Path to the directory where files will be copied
     */
    public static async copyFilesToOutput(
        files: FileInfo[],
        outputPath: string
    ): Promise<void> {
        for (const file of files) {
            const targetPath = path.join(outputPath, file.relativePath);
            // Create required directories
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.copyFile(file.absolutePath, targetPath);
            // Set modification time to match the original
            await fs.utimes(targetPath, new Date(), file.updateTime);
        }
    }

    /**
     * Checks whether the normalized relative file path matches any of the exclude patterns.
     * @param filePath Normalized relative path of the file or directory
     * @param excludePatterns Array of glob patterns for exclusion
     * @returns true if the file should be excluded, otherwise false
     */
    private static shouldExclude(filePath: string, excludePatterns: string[]): boolean {
        return excludePatterns.some(pattern => minimatch(filePath, pattern, { dot: true }));
    }
}