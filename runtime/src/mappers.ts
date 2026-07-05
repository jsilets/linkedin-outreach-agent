// Row -> domain mappers. The orchestrator already exports campaign/target/
// message/account mappers; re-export them so the runtime has one import site,
// and add nothing that duplicates them.

export {
  rowToAccount,
  rowToCampaign,
  rowToMessage,
  rowToTarget,
} from '@loa/orchestrator';
