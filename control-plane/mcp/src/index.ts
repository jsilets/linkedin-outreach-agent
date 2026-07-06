// @loa/mcp — the MCP server exposing the agent-facing tool surface.
//
// Public surface: the ports (integration contract other packages satisfy), the
// gate chokepoint, the tool registry, and the server/app builders. Import
// domain types from @loa/shared.

export type {
  Ports,
  ObservePort,
  ExecutorPort,
  SafetyPort,
  ApprovalPort,
  CampaignPort,
  AccountAdminPort,
  ActRequest,
  PendingItem,
  QueueEntry,
  Metrics,
  TargetInput,
  CampaignStepView,
  SequenceStepInput,
  EnrollResult,
  HealthReport,
  AuditRecord,
  ProfileSummary,
  PostSummary,
  EngagerSummary,
  JobSummary,
  ConversationSummary,
  PeopleQuery,
  PersonSearchResult,
} from './ports.js';

export { gateAct, mayExecuteDirectly, type GateOutcome, type GateDeps } from './gate.js';
export { requirePrivileged, CapabilityError } from './capability.js';
export { AGENT_CONTEXT, operatorContext, type RequestContext } from './context.js';
export { ALL_TOOLS, TOOLS_BY_NAME, type ToolDef, type ToolFamily } from './tools.js';
export { createApp, buildMcpServer, startServer, contextFromHeaders } from './server.js';
