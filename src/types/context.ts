export interface ConfigFileInfo {
  path: string;
  content: string;
}

export interface ProjectContext {
  workDir: string;
  directoryTree: string;
  configFiles: ConfigFileInfo[];
  gitignorePatterns: string[];
}

export interface FileContentReference {
  __type: 'file_content_reference';
  filePath: string;
  readAtMtime: number;
}

export function isFileContentReference(value: unknown): value is FileContentReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as FileContentReference).__type === 'file_content_reference' &&
    typeof (value as FileContentReference).filePath === 'string' &&
    typeof (value as FileContentReference).readAtMtime === 'number'
  );
}
