import path from 'path';

/**
 * Normalizes a path by replacing the system separator with "/" (unifies paths for Windows and Unix).
 * @param filePath Path to normalize
 * @returns Normalized path
 */
export function normalizePath(filePath: string): string {
    return filePath.split(path.sep).join('/');
}