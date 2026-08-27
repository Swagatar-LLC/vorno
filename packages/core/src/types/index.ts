/**
 * Re-export all types from @craft-agent/core
 */

// Workspace and config types
export type {
  WorkspaceInfo,
  Workspace,
  RemoteServerConfig,
  McpAuthType,
  AuthType,
  OAuthCredentials,
  StoredConfig,
} from './workspace.ts';

// Session types
export type {
  Session,
  StoredSession,
  SessionMetadata,
  SessionStatus,
} from './session.ts';

// Message types
export type {
  MessageRole,
  ToolStatus,
  ToolDisplayMeta,
  AttachmentType,
  MessageAttachment,
  StoredAttachment,
  ContentBadge,
  AnnotationAuthor,
  AnnotationBody,
  AnnotationIntent,
  AnnotationStatus,
  AnnotationBlockType,
  AnnotationSelector,
  AnnotationTarget,
  AnnotationV1,
  AnnotationMutationFailureReason,
  AnnotationMutationResult,
  Message,
  StoredMessage,
  TokenUsage,
  AgentEventUsage,
  RecoveryAction,
  ErrorCode,
  TypedError,
  PermissionRequest,
  AgentEvent,
  // Auth-related types
  CredentialInputMode,
  AuthRequestType,
  AuthStatus,
} from './message.ts';
export { generateMessageId } from './message.ts';

// Message persistence mappers
export { messageToStored, storedToMessage } from './message-mapper.ts';

// Server types (headless operations)
export type {
  ServerStatus,
  ServerHealth,
  SessionProcessingStatus,
  ActiveSessionInfo,
} from './server.ts';


// Workbench types (dynamic workspace surfaces — ADR-0014, PLAN-024)
export type {
  ArtifactVersion,
  WorkbenchArtifactKind,
  ArtifactRef,
  WorkbenchSessionLink,
  ReviewThreadKind,
  ReviewThreadStatus,
  ReviewThreadV1,
  WorkbenchType,
  WorkbenchInstanceV1,
} from './workbench.ts';

// Artifact plane types (generalized artifact plane — ADR-0016, PLAN-025)
export type {
  ParsedArtifactUri,
  ArtifactSkippedRoot,
  ArtifactOriginKind,
  ArtifactOrigin,
  ArtifactEntry,
  StorageCapabilities,
  FilesystemRootConfig,
  RootBindingConfig,
  ArtifactRootsConfig,
  RootHealth,
  ArtifactTypeDescriptor,
  ArtifactRelationKind,
  ArtifactRelation,
} from './artifacts.ts';

// Headroom integration config (fork: PLAN-040, SUV-0016)
export type {
  HeadroomVerbosity,
  HeadroomConfig,
  HeadroomConfigOverrides,
  HeadroomConfigField,
  HeadroomConfigSource,
  HeadroomConfigSources,
} from './headroom.ts';
export {
  HEADROOM_VERBOSITY_VALUES,
  HEADROOM_CONFIG_DEFAULTS,
  HEADROOM_CONFIG_FIELDS,
  sanitizeHeadroomConfigLayer,
  resolveHeadroomConfig,
  resolveHeadroomConfigSources,
} from './headroom.ts';

// Headroom adapter boundary contract (fork: PLAN-040, SUV-0015)
export type {
  HeadroomMessageRole,
  HeadroomMessage,
  HeadroomUnavailableReason,
  HeadroomMeasurement,
  HeadroomCompressStats,
  HeadroomUsageStats,
  HeadroomCompressRequest,
  HeadroomCompressResult,
  HeadroomRetrieveMiss,
  HeadroomRetrieveResult,
  HeadroomAdapterKind,
  HeadroomAdapter,
  HeadroomAdapterOptions,
} from './headroom-adapter.ts';
export {
  HEADROOM_MESSAGE_ROLES,
  headroomUnavailable,
  headroomMeasured,
} from './headroom-adapter.ts';
