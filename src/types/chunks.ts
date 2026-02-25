export interface ImportDeclaration {
  source: string;
  specifiers: string[];
  isRelative: boolean;
}

export interface ChunkMetadata {
  filePath: string;
  startLine: number;
  endLine: number;
  parentScope: string;
  imports: ImportDeclaration[];
  language: string;
  chunkType: 'function' | 'class' | 'method' | 'module' | 'block' | 'text';
}

export interface Chunk {
  id: string;
  content: string;
  metadata: ChunkMetadata;
}

export interface IndexedChunk extends Chunk {
  embedding: number[];
  fileHash: string;
}
