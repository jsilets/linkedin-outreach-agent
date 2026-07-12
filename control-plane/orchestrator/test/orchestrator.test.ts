import { describe, expect, it } from 'vitest';
import { ApprovalService } from '../src/approvals.js';
import { CampaignService } from '../src/campaigns.js';
import { EventLog } from '../src/event-log.js';
import { ReplyRouter } from '../src/reply-router.js';
import { SuppressionService } from '../src/suppression.js';
import {
  InMemApprovalRepo,
  InMemCampaignRepo,
  InMemEventRepo,
  InMemMessageRepo,
  InMemScheduler,
  InMemTargetRepo,
} from './fakes.js';

function wire() {
  const campaignRepo = new InMemCampaignRepo();
  const targetRepo = new InMemTargetRepo();
  const messageRepo = new InMemMessageRepo();
  const approvalRepo = new InMemApprovalRepo();
  const eventRepo = new InMemEventRepo();
  const scheduler = new InMemScheduler();
  const log = new EventLog(eventRepo);
  const suppression = new SuppressionService(targetRepo, eventRepo, log);
  return {
    campaignRepo,
    targetRepo,
    messageRepo,
    approvalRepo,
    eventRepo,
    scheduler,
    log,
    suppression,
    campaigns: new CampaignService(campaignRepo, targetRepo, log),
    approvals: new ApprovalService(messageRepo, approvalRepo, log),
    router: new ReplyRouter(targetRepo, suppression, scheduler, log),
  };
}

describe('CampaignService', () => {
  it('creates a campaign, adds targets, attaches context, and reads/sets autonomy', async () => {
    const w = wire();
    const camp = await w.campaigns.createCampaign({
      goal: 'book intro calls',
      messageStrategy: 'warm',
      owner: 'operator',
    });
    expect(camp.autonomyLevel).toBe('supervised');

    const targets = await w.campaigns.addTargets(camp.id, [
      { prospectRef: 'crm-1', linkedinUrn: 'urn:1' },
      { prospectRef: 'crm-2', linkedinUrn: 'urn:2', externalContext: { note: 'warm intro' } },
    ]);
    expect(targets).toHaveLength(2);

    const withCtx = await w.campaigns.attachExternalContext(targets[0]!.id, { company: 'Acme' });
    expect(withCtx.externalContext).toMatchObject({ company: 'Acme' });

    await w.campaigns.setAutonomyLevel(camp.id, 'semi_auto');
    expect(await w.campaigns.readAutonomyLevel(camp.id)).toBe('semi_auto');
  });

  it('attachExternalContext merges into existing context instead of replacing it', async () => {
    const w = wire();
    const camp = await w.campaigns.createCampaign({
      goal: 'g',
      messageStrategy: 'm',
      owner: 'operator',
    });
    const [target] = await w.campaigns.addTargets(camp.id, [
      {
        prospectRef: 'crm-1',
        linkedinUrn: 'urn:1',
        externalContext: { name: 'Ada', headline: 'VP Ops', note: 'warm' },
      },
    ]);

    // Attaching a score must keep the profile fields already on the target.
    const scored = await w.campaigns.attachExternalContext(target!.id, {
      score: 80,
      scoreReasons: ['VP Ops at a target account'],
    });
    expect(scored.externalContext).toMatchObject({
      name: 'Ada',
      headline: 'VP Ops',
      note: 'warm',
      score: 80,
      scoreReasons: ['VP Ops at a target account'],
    });

    // A double-encoded (JSON-string) blob is parsed, not stored as a string,
    // and still merges. Right side wins on key collision.
    const merged = await w.campaigns.attachExternalContext(
      target!.id,
      JSON.stringify({ score: 90, icp: 'network-cpo' }) as never,
    );
    expect(merged.externalContext).toMatchObject({
      name: 'Ada',
      score: 90,
      icp: 'network-cpo',
    });
  });

  it('attachExternalContext rejects a non-object blob rather than clobbering', async () => {
    const w = wire();
    const camp = await w.campaigns.createCampaign({
      goal: 'g',
      messageStrategy: 'm',
      owner: 'operator',
    });
    const [target] = await w.campaigns.addTargets(camp.id, [
      { prospectRef: 'crm-1', linkedinUrn: 'urn:1', externalContext: { name: 'Ada' } },
    ]);
    await expect(w.campaigns.attachExternalContext(target!.id, 42 as never)).rejects.toThrow(
      /must be a JSON object/,
    );
  });

  it('stores the canonical bare urn and dedupes the same person across urn forms', async () => {
    const w = wire();
    const camp = await w.campaigns.createCampaign({
      goal: 'g',
      messageStrategy: 's',
      owner: 'o',
    });
    const wrappedA =
      'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACo1,SEARCH_SRP,DEFAULT)';
    const wrappedB = 'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACo1,PEOPLE,DEFAULT)';

    const first = await w.campaigns.addTargets(camp.id, [
      { prospectRef: 'a', linkedinUrn: wrappedA },
    ]);
    expect(first).toHaveLength(1);
    expect(first[0]!.linkedinUrn).toBe('urn:li:fsd_profile:ACo1'); // persisted bare, not the wrapper

    // Same person via a different search wrapper: deduped against the stored bare key.
    const second = await w.campaigns.addTargets(camp.id, [
      { prospectRef: 'a2', linkedinUrn: wrappedB },
    ]);
    expect(second).toHaveLength(0);

    // Within a single batch, a bare and a wrapped form of one person collapse too.
    const batch = await w.campaigns.addTargets(camp.id, [
      { prospectRef: 'b', linkedinUrn: 'urn:li:fsd_profile:ACo2' },
      {
        prospectRef: 'b2',
        linkedinUrn:
          'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACo2,SEARCH_SRP,DEFAULT)',
      },
    ]);
    expect(batch).toHaveLength(1);
  });
});

describe('ApprovalService', () => {
  it('approve writes an approval row and an event, and marks the draft approved', async () => {
    const w = wire();
    const { pendingItemRef } = await w.approvals.enqueuePending({
      accountId: 'acct-1',
      targetId: 'tgt-1',
      campaignId: 'camp-1',
      threadRef: 'thread-1',
      draft: { body: 'hello there' },
    });

    const decision = await w.approvals.approve(pendingItemRef, 'operator');
    expect(decision.decision).toBe('approved');
    // Approval marks it 'approved' (queued to send); the dispatch tick sends it.
    expect(decision.message.status).toBe('approved');
    expect(w.approvalRepo.rows).toHaveLength(1);
    expect(w.approvalRepo.rows[0]!.decision).toBe('approved');
    expect(w.eventRepo.rows.map((e) => e.kind)).toContain('approval_decided');
  });

  it('reject writes an approval row + event and marks the draft rejected', async () => {
    const w = wire();
    const { pendingItemRef } = await w.approvals.enqueuePending({
      accountId: 'acct-1',
      targetId: 'tgt-1',
      campaignId: 'camp-1',
      threadRef: 'thread-1',
      draft: { body: 'hello there' },
    });
    const decision = await w.approvals.reject(pendingItemRef, 'operator');
    expect(decision.decision).toBe('rejected');
    // Terminal 'rejected': it leaves the pending queue and blocks a later approve.
    expect(decision.message.status).toBe('rejected');
    expect(w.approvalRepo.rows[0]!.decision).toBe('rejected');
    expect(w.eventRepo.rows.map((e) => e.kind)).toContain('approval_decided');
    await expect(w.approvals.approve(pendingItemRef, 'operator')).rejects.toThrow(
      /already decided/,
    );
  });

  it('edit_and_approve changes the body then marks it approved', async () => {
    const w = wire();
    const { pendingItemRef } = await w.approvals.enqueuePending({
      accountId: 'acct-1',
      targetId: 'tgt-1',
      campaignId: 'camp-1',
      threadRef: 'thread-1',
      draft: { body: 'original' },
    });
    const decision = await w.approvals.editAndApprove(pendingItemRef, 'operator', 'edited body');
    expect(decision.decision).toBe('edited');
    expect(decision.message.body).toBe('edited body');
    expect(decision.message.status).toBe('approved');
  });

  it('lists pending draft items in a thread', async () => {
    const w = wire();
    await w.approvals.enqueuePending({
      accountId: 'acct-1',
      targetId: 'tgt-1',
      campaignId: 'camp-1',
      threadRef: 'thread-1',
      draft: { body: 'one' },
    });
    const pending = await w.approvals.listPending('thread-1');
    expect(pending).toHaveLength(1);
  });
});

describe('EventLog is append-only', () => {
  it('exposes only append + reads; recordEvent is the write path', async () => {
    const w = wire();
    await w.log.recordEvent('thing_happened', 'acct-1', { a: 1 });
    await w.log.recordEvent('thing_happened', 'acct-1', { a: 2 });
    expect(w.eventRepo.rows).toHaveLength(2);
    // The repo port has no update/delete surface.
    expect('update' in w.eventRepo).toBe(false);
    expect('delete' in w.eventRepo).toBe(false);
    // Rows are immutable once written: appending never mutates prior rows.
    const firstId = w.eventRepo.rows[0]!.id;
    await w.log.recordEvent('thing_happened', 'acct-1', { a: 3 });
    expect(w.eventRepo.rows[0]!.id).toBe(firstId);
  });
});

describe('ReplyRouter', () => {
  it('Stop hard-suppresses the target across all campaigns and marks it lost', async () => {
    const w = wire();
    // Same person (URN) sourced into two campaigns.
    const a = await w.targetRepo.create({
      campaignId: 'camp-A',
      prospectRef: 'crm-1',
      linkedinUrn: 'urn:person:X',
    });
    const b = await w.targetRepo.create({
      campaignId: 'camp-B',
      prospectRef: 'crm-1',
      linkedinUrn: 'urn:person:X',
    });

    const outcome = await w.router.route({
      targetId: a.id,
      campaignId: 'camp-A',
      intent: 'Stop',
    });
    expect(outcome.suppressed).toBe(true);
    expect(outcome.stage).toBe('lost');

    // Suppression is by URN, so the OTHER campaign's target is suppressed too.
    expect(await w.suppression.isSuppressed(a.id)).toBe(true);
    expect(await w.suppression.isSuppressed(b.id)).toBe(true);
    expect(w.eventRepo.rows.map((e) => e.kind)).toContain('target_suppressed');
  });

  it('suppression matches across wrapped and bare urn forms of one person', async () => {
    const w = wire();
    // Same person, but one campaign stored the search wrapper and the other the
    // bare urn. Before canonicalization the wrapped one would never match.
    const wrapped = await w.targetRepo.create({
      campaignId: 'camp-A',
      prospectRef: 'a',
      linkedinUrn: 'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoZ,SEARCH_SRP,DEFAULT)',
    });
    const bare = await w.targetRepo.create({
      campaignId: 'camp-B',
      prospectRef: 'b',
      linkedinUrn: 'urn:li:fsd_profile:ACoZ',
    });

    const res = await w.suppression.suppressByTarget(wrapped.id);
    expect(res.linkedinUrn).toBe('urn:li:fsd_profile:ACoZ'); // recorded under the canonical key

    expect(await w.suppression.isSuppressed(wrapped.id)).toBe(true);
    expect(await w.suppression.isSuppressed(bare.id)).toBe(true);
    expect(await w.suppression.isUrnSuppressed('urn:li:fsd_profile:ACoZ')).toBe(true);
  });

  it('Interested and Question route to a drafted reply behind the human gate', async () => {
    const w = wire();
    const t = await w.targetRepo.create({
      campaignId: 'camp-1',
      prospectRef: 'crm-1',
      linkedinUrn: 'urn:1',
    });
    for (const intent of ['Interested', 'Question'] as const) {
      const outcome = await w.router.route({ targetId: t.id, campaignId: 'camp-1', intent });
      expect(outcome.needsReply).toBe(true);
      expect(outcome.suppressed).toBe(false);
      expect(outcome.scheduledFollowUp).toBe(false);
      expect(outcome.stage).toBe('in_conversation');
    }
  });

  it('NotNow and OutOfOffice update state and emit a paced follow-up to the scheduler', async () => {
    const w = wire();
    const t = await w.targetRepo.create({
      campaignId: 'camp-1',
      prospectRef: 'crm-1',
      linkedinUrn: 'urn:1',
    });
    const now = new Date('2026-07-05T00:00:00Z');
    await w.router.route({
      targetId: t.id,
      campaignId: 'camp-1',
      intent: 'NotNow',
      now,
      followUpDelayMs: 1000,
    });
    expect(w.scheduler.enqueued).toHaveLength(1);
    expect(w.scheduler.enqueued[0]!.notBefore).toEqual(new Date(now.getTime() + 1000));
    expect(w.scheduler.enqueued[0]!.reason).toBe('not_now_followup');
  });

  it('NotInterested marks the target lost with no follow-up and no reply', async () => {
    const w = wire();
    const t = await w.targetRepo.create({
      campaignId: 'camp-1',
      prospectRef: 'crm-1',
      linkedinUrn: 'urn:1',
    });
    const outcome = await w.router.route({
      targetId: t.id,
      campaignId: 'camp-1',
      intent: 'NotInterested',
    });
    expect(outcome.stage).toBe('lost');
    expect(outcome.needsReply).toBe(false);
    expect(w.scheduler.enqueued).toHaveLength(0);
  });
});
