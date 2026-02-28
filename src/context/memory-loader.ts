import * as fs from 'fs/promises';
import * as path from 'path';

export interface MemoryFile {
  /** Absolute path to the CLAUDE.md file */
  absolutePath: string;
  /** File content (UTF-8) */
  content: string;
}

/**
 * Traverses from `workDir` up to the filesystem root, collecting all CLAUDE.md files.
 * Returns files in root-first order (outermost → innermost).
 * Skips files that cannot be read due to permission errors or are empty.
 */
export async function loadMemoryFiles(workDir: string): Promise<MemoryFile[]> {
  const candidates: MemoryFile[] = [];
  let current = path.resolve(workDir);

  while (true) {
    const candidatePath = path.join(current, 'CLAUDE.md');

    try {
      const content = await fs.readFile(candidatePath, 'utf-8');
      if (content.trim().length > 0) {
        candidates.push({ absolutePath: candidatePath, content });
      }
    } catch (err: unknown) {
      // Skip files that don't exist or can't be read (permission errors, etc.)
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
        // Unexpected error — log and continue
        console.warn(`[MemoryLoader] Unexpected error reading ${candidatePath}:`, err);
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root
      break;
    }
    current = parent;
  }

  // candidates is innermost-first; reverse to get root-first (outermost → innermost)
  return candidates.reverse();
}

/**
 * Formats a list of MemoryFile entries into a string suitable for injection into a system prompt.
 * Returns an empty string if the files array is empty.
 */
export function formatMemorySection(files: MemoryFile[]): string {
  if (files.length === 0) {
    return '';
  }

  const sections = files.map(
    (file) => `--- CLAUDE.md: ${file.absolutePath} ---\n${file.content}`
  );

  return `## Project Memory (CLAUDE.md)\n\n${sections.join('\n\n')}`;
}
