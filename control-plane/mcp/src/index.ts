// @loa/mcp — the MCP server exposing the agent-facing tool surface.
//
// Public surface: the ports (integration contract other packages satisfy), the
// gate chokepoint, the tool registry, and the server/app builders. Import
// domain types from @loa/shared.

export { CapabilityError, requirePrivileged } from './capability.js';
export { AGENT_CONTEXT, operatorContext, type RequestContext } from './context.js';
export { type GateDeps, type GateOutcome, gateAct, mayExecuteDirectly } from './gate.js';
export type {
  AccountAdminPort,
  ActRequest,
  ApprovalOutcome,
  ApprovalPort,
  AuditRecord,
  CampaignPort,
  CampaignStepView,
  ConversationSummary,
  DiscoveryPort,
  EngagerSummary,
  EnrollResult,
  ExecutorPort,
  HealthReport,
  Icp,
  IcpAttribute,
  IcpField,
  InsertMembersResult,
  JobSummary,
  LeadListPort,
  LeadScoreInput,
  ListDetail,
  ListMember,
  ListSummary,
  Metrics,
  ObservePort,
  PendingItem,
  PeopleQuery,
  PersonSearchResult,
  Ports,
  PostSummary,
  ProfilePosition,
  ProfileSummary,
  QueueEntry,
  RecentConnection,
  RemoveTargetsResult,
  SafetyPort,
  ScoreLeadsResult,
  ScoreListResult,
  SequenceStepInput,
  TargetInput,
} from './ports.js';
export { type AuthResult, authenticate, buildMcpServer, createApp, startServer } from './server.js';
export { type SourceToListResult, sourceToList } from './source-to-list.js';
export { ALL_TOOLS, TOOLS_BY_NAME, type ToolDef, type ToolFamily } from './tools.js';
