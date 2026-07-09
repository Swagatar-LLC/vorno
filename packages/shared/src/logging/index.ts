/**
 * fork(PLAN-015): shared production-logging helpers.
 */

export {
  LOG_LEVELS,
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_ENV_VAR,
  isLogLevel,
  resolveLogLevel,
  localDateStamp,
  dailyLogFileName,
  parseDailyLogFileName,
  nextArchiveFileName,
  pruneDailyLogs,
  formatLogLine,
  type LogLevel,
  type LogLevelState,
  type ParsedLogFileName,
  type PruneOptions,
  type LogLineParts,
} from './file-log.ts';

export { redactSecrets } from './redact.ts';
