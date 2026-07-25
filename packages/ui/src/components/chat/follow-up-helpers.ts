export {
  type AnnotationFollowUpState,
  asRecord,
  normalizeFollowUpText,
  getAnnotationNoteText,
  getAnnotationFollowUpState,
  isAnnotationFollowUpSent,
  // Moved to `annotations/follow-up-state` so the renderer's pure follow-up
  // module can import it without pulling in the React chat barrel — `./chat`
  // is an exported subpath of this package, `./chat/follow-up-helpers` is not.
  // Re-exported here so existing consumers are unaffected.
  extractAnnotationSelectedText,
} from '../annotations/follow-up-state'
