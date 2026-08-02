import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import {
  getUserStorage,
  type StorageCleanupScope,
} from '@/modules/code/storage';
import { cleanupStorage } from '@/modules/code/storage-cleanup';
import { getAllConfigs } from '@/modules/config/service';
import { respData, respErr } from '@/lib/resp';

async function POST({ request }: { request: Request }) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return respErr('Unauthorized', { status: 401 });
    }
    const body = await request.json().catch(() => ({}));
    const scope = body.scope as StorageCleanupScope;
    if (!['snapshots', 'all-snapshots', 'session'].includes(scope)) {
      return respErr('Invalid cleanup scope', { status: 400 });
    }
    const result = await cleanupStorage({
      userId: session.user.id,
      scope,
      sessionId:
        typeof body.sessionId === 'string' ? body.sessionId : undefined,
    });
    const configs = await getAllConfigs();
    return respData({
      cleanup: result.cleanup,
      storage: await getUserStorage(session.user.id, configs),
    });
  } catch (error) {
    return respErr(
      error instanceof Error ? error.message : 'Storage cleanup failed'
    );
  }
}

export const Route = createFileRoute('/api/storage/cleanup')({
  server: { handlers: { POST } },
});
