export {
  ReviewEngine,
  StaleChangeError,
  NotPendingError,
  DEFAULT_LARGE_FILE_THRESHOLD,
  type ReviewEngineOptions,
  type FsEvent,
  type ChangeKind,
  type ChangeSummary,
  type FileChange,
  type ChangeReason,
  type ChangeEvent,
  type GitOperationResult,
  type BulkResult,
  type UserSaveOptions,
  type UserSaveResult,
} from './engine.js';
export { MultiRootReview, storageDirForRoot, type MultiRootOptions } from './multiRoot.js';
export { type TrackedEdit, type EditOrigin, type Provenance, type SavedLine, trackEdits, provenanceFromDiff, addFormatterPass, foldUserSave } from './attribution.js';
export { type Hunk, computeHunks, acceptHunks, rejectHunks, hunkRegion } from './diff/hunks.js';
export { type InlineRange, type WordDiff, wordDiff, tokenize } from './diff/words.js';
export { type Region, diffRegions } from './diff/myers.js';
export { stagedRegions } from './staging.js';
export { IgnoreRules, DEFAULT_IGNORE_PATTERNS, LATEX_ARTIFACT_PATTERNS, BUILD_DIR_PATTERNS, type IgnoreOptions } from './ignore.js';
export { type FileSystem, type FileStat, type FileType, type DirEntry, NodeFileSystem, nodeFileSystem, MemoryFileSystem } from './fs.js';
export { type GitObjectReader, type GitRepoInfo, type HeadState, gitCliObjectReader, parseIndex } from './git/repo.js';
export { gitBlobId } from './store/objectStore.js';
export { splitLines, joinLines, isBinary } from './text.js';
export { restoreLineEndings, equalIgnoringEol } from './eol.js';
