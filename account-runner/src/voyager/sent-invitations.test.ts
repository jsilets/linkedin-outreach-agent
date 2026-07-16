import { describe, expect, it } from 'vitest';
import type { PagePort } from '../ports.js';
import {
  invitationIdFromUrn,
  normalizeSentInvitationsResponse,
  readSentInvitations,
  sentInvitationsPath,
  withdrawInvitationPath,
} from './sent-invitations.js';

// All fixtures use FICTIONAL names / slugs / urns — the repo is public.

/** A normalized dash-shape body: included[] holds Invitation + Profile entities,
 * with data.*elements giving order and invitee.*miniProfile a urn ref. */
function dashSentBody(
  people: Array<{
    id: string;
    profileId: string;
    slug: string;
    first: string;
    last: string;
    sentTime: number;
    note?: string;
  }>,
) {
  return {
    data: { '*elements': people.map((p) => `urn:li:fsd_invitation:${p.id}`) },
    included: [
      ...people.map((p) => ({
        entityUrn: `urn:li:fsd_invitation:${p.id}`,
        $type: 'com.linkedin.voyager.relationships.invitation.Invitation',
        sentTime: p.sentTime,
        ...(p.note ? { message: p.note } : {}),
        invitee: { '*miniProfile': `urn:li:fsd_profile:${p.profileId}` },
      })),
      ...people.map((p) => ({
        entityUrn: `urn:li:fsd_profile:${p.profileId}`,
        publicIdentifier: p.slug,
        firstName: p.first,
        lastName: p.last,
      })),
    ],
  };
}

/** A decorated legacy REST body: elements[] carry an inline invitee.miniProfile. */
function legacySentBody(
  people: Array<{ id: string; slug: string; first: string; last: string; sentTime: number }>,
) {
  return {
    elements: people.map((p) => ({
      entityUrn: `urn:li:invitation:${p.id}`,
      sentTime: p.sentTime,
      invitee: {
        miniProfile: {
          entityUrn: `urn:li:fs_miniProfile:${p.slug}`,
          publicIdentifier: p.slug,
          firstName: p.first,
          lastName: p.last,
        },
      },
    })),
  };
}

describe('invitationIdFromUrn', () => {
  it('extracts the numeric tail from both urn forms', () => {
    expect(invitationIdFromUrn('urn:li:invitation:7123')).toBe('7123');
    expect(invitationIdFromUrn('urn:li:fsd_invitation:7124')).toBe('7124');
  });
});

describe('sentInvitationsPath / withdrawInvitationPath', () => {
  it('builds the paginated read path', () => {
    const path = sentInvitationsPath(100, 100);
    expect(path).toContain('q=invitationType');
    expect(path).toContain('invitationType=CONNECTION');
    expect(path).toContain('start=100');
    expect(path).toContain('count=100');
  });

  it('url-encodes the fsd_invitation urn onto the withdraw action path', () => {
    const path = withdrawInvitationPath('7125');
    expect(path).toContain(encodeURIComponent('urn:li:fsd_invitation:7125'));
    expect(path).toContain('action=withdraw');
  });
});

describe('normalizeSentInvitationsResponse', () => {
  it('resolves the normalized dash shape, preserving *elements order', () => {
    const body = dashSentBody([
      {
        id: '11',
        profileId: 'ACoAAOne',
        slug: 'robin-oak',
        first: 'Robin',
        last: 'Oak',
        sentTime: 30,
        note: 'Hi Robin',
      },
      {
        id: '12',
        profileId: 'ACoAATwo',
        slug: 'sam-vale',
        first: 'Sam',
        last: 'Vale',
        sentTime: 10,
      },
    ]);
    const invs = normalizeSentInvitationsResponse(body);
    expect(invs.map((i) => i.invitationUrn)).toEqual([
      'urn:li:fsd_invitation:11',
      'urn:li:fsd_invitation:12',
    ]);
    expect(invs[0]).toMatchObject({
      inviteeUrn: 'urn:li:fsd_profile:ACoAAOne',
      publicIdentifier: 'robin-oak',
      profileUrl: 'https://www.linkedin.com/in/robin-oak/',
      name: 'Robin Oak',
      message: 'Hi Robin',
    });
    expect(invs[0]!.sentAt?.getTime()).toBe(30);
    expect(invs[1]!.name).toBe('Sam Vale');
  });

  it('resolves the decorated legacy shape with an inline miniProfile', () => {
    const body = legacySentBody([
      { id: '21', slug: 'lee-park', first: 'Lee', last: 'Park', sentTime: 99 },
    ]);
    const invs = normalizeSentInvitationsResponse(body);
    expect(invs).toHaveLength(1);
    expect(invs[0]).toMatchObject({
      invitationUrn: 'urn:li:invitation:21',
      publicIdentifier: 'lee-park',
      profileUrl: 'https://www.linkedin.com/in/lee-park/',
      name: 'Lee Park',
    });
    expect(invs[0]!.sentAt?.getTime()).toBe(99);
  });

  it('keeps an invite whose invitee could not be resolved (no sentAt is null-safe)', () => {
    const invs = normalizeSentInvitationsResponse({
      elements: [{ entityUrn: 'urn:li:invitation:31' }],
    });
    expect(invs).toEqual([{ invitationUrn: 'urn:li:invitation:31' }]);
  });

  it('returns [] for an empty or unrecognized body', () => {
    expect(normalizeSentInvitationsResponse({})).toEqual([]);
    expect(normalizeSentInvitationsResponse(null)).toEqual([]);
  });
});

/** Minimal page that returns preloaded voyagerGet pages in order. */
class SentInvitesFakePage implements Pick<PagePort, 'voyagerGet'> {
  readonly calls: string[] = [];
  private readonly queue: unknown[];
  constructor(pages: unknown[]) {
    this.queue = [...pages];
  }
  async voyagerGet(pathWithQuery: string): Promise<{ status: number; body: unknown }> {
    this.calls.push(pathWithQuery);
    const body = this.queue.length > 1 ? this.queue.shift() : this.queue[0];
    return { status: 200, body };
  }
}

describe('readSentInvitations', () => {
  it('drives voyagerGet and normalizes one page', async () => {
    const page = new SentInvitesFakePage([
      dashSentBody([
        {
          id: '41',
          profileId: 'ACoAAFour',
          slug: 'ada-fen',
          first: 'Ada',
          last: 'Fen',
          sentTime: 5,
        },
      ]),
    ]);
    const invs = await readSentInvitations(page);
    expect(invs.map((i) => i.invitationUrn)).toEqual(['urn:li:fsd_invitation:41']);
    expect(page.calls[0]).toContain('/voyager/api/relationships/sentInvitationViewsV2');
    expect(page.calls[0]).toContain('q=invitationType');
  });

  it('honors the caller limit and stops early', async () => {
    const many = Array.from({ length: 3 }, (_v, i) => ({
      id: `5${i}`,
      profileId: `ACoAAP${i}`,
      slug: `p-${i}`,
      first: 'P',
      last: `${i}`,
      sentTime: i,
    }));
    const page = new SentInvitesFakePage([dashSentBody(many)]);
    const invs = await readSentInvitations(page, { limit: 2 });
    expect(invs).toHaveLength(2);
  });

  it('throws when the first page is a non-200', async () => {
    const page: Pick<PagePort, 'voyagerGet'> = {
      voyagerGet: async () => ({ status: 400, body: null }),
    };
    await expect(readSentInvitations(page)).rejects.toThrow(/HTTP 400/);
  });
});
