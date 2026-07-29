import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { getUserStorage } from '@/modules/code/storage';
import { cleanupStorage } from '@/modules/code/storage-cleanup';
import { getAllConfigs } from '@/modules/config/service';
import { respData, respErr } from '@/lib/resp';

async function DELETE({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return respErr('Unauthorized', { status: 401 });
    }
    const result = await cleanupStorage({
      userId: session.user.id,
      scope: 'object',
      objectId: params.id,
    });
    if (result.pending.length === 0) {
      return respErr('Storage object not found', { status: 404 });
    }
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

export const Route = createFileRoute('/api/storage/objects/$id')({
  server: { handlers: { DELETE } },
});
