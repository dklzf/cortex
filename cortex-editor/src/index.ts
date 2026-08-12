// Main package exports
export type {
  EditKind,
  FrameworkAdapter,
  TransformResult,
  SourceMap,
  SourceTransformOptions,
  ServerChannel,
  BrowserToServer,
  ServerToBrowser,
  ElementContext,
  ConnectionState,
  ConnectionDisplay,
  CortexChannel,
} from './adapters/types.js'

export { createSourceTransform } from './adapters/source-transform.js'

// Core edit pipeline
export { EditPipeline } from './core/edit-pipeline.js'
export type { EditRequest, EditPipelineOptions } from './core/edit-pipeline.js'
export { TailwindResolver } from './core/tailwind-resolver.js'
export type { ResolvedTheme } from './core/tailwind-resolver.js'
export { TailwindRewriter } from './core/rewriter/tailwind.js'
export { InlineStyleRewriter } from './core/rewriter/inline-style.js'
export type { InlineStyleRewriteRequest } from './core/rewriter/inline-style.js'
export type { RewriteRequest, RewriteResult } from './core/rewriter/types.js'
export { cssPropertyToCamelCase } from './core/rewriter/jsx-utils.js'
export { HMRVerifier } from './core/hmr-verifier.js'
export type { PendingEdit } from './core/hmr-verifier.js'

// Phase 8a: CSS Modules + Undo/Redo
export { CSSModulesRewriter } from './core/rewriter/css-modules.js'
export type { CSSModulesRewriteRequest } from './core/rewriter/css-modules.js'
export { StyleDetector } from './core/rewriter/detector.js'
export type { StyleSystem, DetectionResult } from './core/rewriter/detector.js'
export { RuntimeCSSResolver } from './core/rewriter/runtime-resolver.js'
export type { ResolvedCSSMapping } from './core/rewriter/runtime-resolver.js'
export { UndoStack } from './core/session/undo-stack.js'
export type { UndoEntry, UndoFileChange, UndoRestoreSet } from './core/session/undo-stack.js'
export { determineWriteStrategy } from './core/rewriter/shorthand.js'
export type { WriteStrategy } from './core/rewriter/shorthand.js'

export { ToolApplicator } from './core/tool-applicator.js'
export type { ToolAction, ApplyResult } from './core/tool-applicator.js'

// Phase 8b: Capabilities, v4 parser, oklch
export { computeCapabilities } from './core/capabilities.js'
export type { StyleCapability, CapabilityStatus, ResolverState } from './core/capabilities.js'
export { parseV4Theme } from './core/tailwind-v4-parser.js'
export { oklchToHex } from './core/oklch.js'
