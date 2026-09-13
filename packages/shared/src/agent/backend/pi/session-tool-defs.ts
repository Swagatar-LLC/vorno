/**
 * Pi Session Tool Proxy Definitions
 *
 * Thin wrapper around the canonical tool definitions in @craft-agent/session-tools-core.
 * Adds the `mcp__session__` prefix that the Pi SDK expects.
 */

import {
  getToolDefsAsJsonSchema,
  SESSION_TOOL_NAMES,
  type JsonSchemaToolDef,
} from '@craft-agent/session-tools-core';
import { FEATURE_FLAGS } from '../../../feature-flags.ts';
import { isPagesEnabled } from '../../../pages/capability.ts';
import { DOC_REFS } from '../../../docs/index.ts';

export type SessionToolProxyDef = JsonSchemaToolDef;

export { SESSION_TOOL_NAMES };

export function getSessionToolProxyDefs(workspaceRootPath?: string): SessionToolProxyDef[] {
  return getToolDefsAsJsonSchema({
    prefix: 'mcp__session__',
    includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
    includePages: isPagesEnabled(workspaceRootPath),
    // fork(SUV-0061): the description resolves the Pages guide on its own rather
    // than deferring to the system prompt's documentation table, so it stays
    // correct if the tool defs are ever read without that prompt.
    docsDir: DOC_REFS.docsDir,
  });
}
