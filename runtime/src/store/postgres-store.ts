// Postgres-backed store: used when DATABASE_URL is set. It wraps PostgresDb and
// the orchestrator's concrete repositories, and adapts the account/action/event
// reads onto the async RuntimeStore surface.
//
// This path is structurally complete and typechecks. It has not been exercised
// against a live database in dev/smoke, which run in memory. Bringing it up
// requires a reachable Postgres with the shared Drizzle schema migrated.

import { db as shared } from '@loa/shared';
import {
  PostgresDb,
  makeRepositories,
  type Db,
  type Repositories,
} from '@loa/orchestrator';
import type { AccountStorePort, ActionStorePort, EventReadPort, RuntimeStore } from './index.js';

class PgAccountStore implements AccountStorePort {
  constructor(private readonly repos: Repositories) {}
  async create(row: shared.NewAccountRow): Promise<shared.AccountRow> {
    return this.repos.account.create(row);
  }
  async findById(id: string): Promise<shared.AccountRow | undefined> {
    return this.repos.account.findById(id);
  }
  async all(): Promise<shared.AccountRow[]> {
    // The orchestrator AccountRepo has no list-all; a live deployment adds one.
    // TODO(p0): add AccountRepo.list() upstream, or a runtime-owned query, to
    // back killAll across every account under Postgres.
    throw new Error('PgAccountStore.all is not implemented; add AccountRepo.list upstream');
  }
  async update(): Promise<shared.AccountRow> {
    // AccountRepo exposes no state/budget mutation yet. Admin pause/resume under
    // Postgres needs an upstream AccountRepo.setState; flagged for P0.
    throw new Error('PgAccountStore.update is not implemented; add AccountRepo.setState upstream');
  }
}

class PgActionStore implements ActionStorePort {
  constructor(private readonly repos: Repositories) {}
  async create(row: shared.NewActionRow): Promise<shared.ActionRow> {
    return this.repos.action.create(row);
  }
  async findById(id: string): Promise<shared.ActionRow | undefined> {
    return this.repos.action.findById(id);
  }
  async listByAccount(): Promise<shared.ActionRow[]> {
    // ActionRepo has no by-account listing yet; the weekly-invite counter needs
    // one under Postgres. Flagged for P0.
    throw new Error('PgActionStore.listByAccount is not implemented; add ActionRepo.listByAccount upstream');
  }
}

class PgEventRead implements EventReadPort {
  constructor(private readonly repos: Repositories) {}
  async append(row: shared.NewEventRow): Promise<shared.EventRow> {
    return this.repos.event.append(row);
  }
  async listSuppression(): Promise<shared.EventRow[]> {
    return this.repos.event.listSuppression();
  }
  async listByAccount(accountId: string): Promise<shared.EventRow[]> {
    return this.repos.event.listByAccount(accountId);
  }
  async listAll(): Promise<shared.EventRow[]> {
    // The orchestrator EventRepo exposes no unbounded list-all (by design; the
    // audit spine is read per-account or per-kind). A live deployment adds a
    // paginated query. Flagged for P0.
    throw new Error('PgEventRead.listAll is not implemented; add a paginated EventRepo query upstream');
  }
}

export class PostgresStore implements RuntimeStore {
  readonly account: AccountStorePort;
  readonly action: ActionStorePort;
  readonly campaign: Repositories['campaign'];
  readonly target: Repositories['target'];
  readonly message: Repositories['message'];
  readonly approval: Repositories['approval'];
  readonly event: EventReadPort;
  private readonly db: Db;

  private readonly repos: Repositories;

  constructor(db: Db) {
    this.db = db;
    const repos = makeRepositories(db);
    this.repos = repos;
    this.account = new PgAccountStore(repos);
    this.action = new PgActionStore(repos);
    this.campaign = repos.campaign;
    this.target = repos.target;
    this.message = repos.message;
    this.approval = repos.approval;
    this.event = new PgEventRead(repos);
  }

  async listTargetsByCampaign(campaignId: string): Promise<shared.TargetRow[]> {
    return this.repos.target.listByCampaign(campaignId);
  }

  async close(): Promise<void> {
    if (this.db instanceof PostgresDb) {
      await this.db.close();
    }
  }
}

/** Build a Postgres store from DATABASE_URL. Throws if the URL is missing. */
export function makePostgresStore(url?: string): PostgresStore {
  const db = new PostgresDb(url ? { url } : {});
  return new PostgresStore(db);
}
