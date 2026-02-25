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
