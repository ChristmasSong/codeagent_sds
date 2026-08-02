import assert from 'node:assert/strict';

import {
  archiveCleanupPlan,
  archiveTemporaryPrefix,
  archiveVersionKey,
  isSessionArchiveKey,
  legacyArchiveKey,
  newestArchiveObject,
  sessionArchivePrefix,
  type ArchiveObjectLike,
} from './archive-storage.ts';

function object(key: string, uploaded: string, size = 100): ArchiveObjectLike {
  return { key, uploaded: new Date(uploaded), size };
}

{
  const prefix = sessionArchivePrefix('user/a', 'session/b');
  assert.equal(prefix, 'integrated-workspaces/user%2Fa/session%2Fb/');
  assert.equal(
    legacyArchiveKey('user/a', 'session/b'),
    `${prefix}workspace.tar.gz`
  );
  assert.equal(
    archiveVersionKey(
      'user/a',
      'session/b',
      new Date('2026-07-27T01:02:03.004Z'),
      'unique'
    ),
    `${prefix}archives/2026-07-27T01-02-03-004Z-unique.tar.gz`
  );
  assert.equal(
    isSessionArchiveKey(
      'user/a',
      'session/b',
      `${prefix}archives/archive.tar.gz`
    ),
    true
  );
  assert.equal(
    isSessionArchiveKey(
      'user/a',
      'session/b',
      'integrated-workspaces/user%2Fa/another-session/archive.tar.gz'
    ),
    false
  );
}

{
  const newest = newestArchiveObject([
    object('older', '2026-07-26T00:00:00.000Z'),
    object('newest', '2026-07-27T00:00:00.000Z'),
  ]);
  assert.equal(newest?.key, 'newest');
}

{
  const now = new Date('2026-07-27T12:00:00.000Z');
  const versions = [
    object('current', '2026-07-27T11:00:00.000Z'),
    object('history-1', '2026-07-27T10:00:00.000Z'),
    object('history-2', '2026-07-26T10:00:00.000Z'),
    object('history-3', '2026-07-25T10:00:00.000Z'),
    object('expired', '2026-07-19T10:00:00.000Z'),
  ];
  const temporary = [
    object(
      `${archiveTemporaryPrefix('user', 'session')}fresh.tar.gz`,
      '2026-07-27T11:00:00.000Z'
    ),
    object(
      `${archiveTemporaryPrefix('user', 'session')}expired.tar.gz`,
      '2026-07-26T10:00:00.000Z'
    ),
  ];

  assert.deepEqual(
    archiveCleanupPlan(versions, temporary, 'current', { now }).map(
      ({ object: candidate, reason }) => [candidate.key, reason]
    ),
    [
      ['history-3', 'history_limit'],
      ['expired', 'history_ttl'],
      [
        `${archiveTemporaryPrefix('user', 'session')}expired.tar.gz`,
        'temporary_ttl',
      ],
    ]
  );

  assert.deepEqual(
    archiveCleanupPlan(versions, [], 'current', {
      now,
      retainPrevious: false,
    }).map(({ object: candidate }) => candidate.key),
    ['history-1', 'history-2', 'history-3', 'expired']
  );
}
