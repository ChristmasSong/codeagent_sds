import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { getUserStorage } from '@/modules/code/storage';
import { reconcileUserStorage } from '@/modules/code/storage-reconciliation';
import { getAllConfigs } from '@/modules/config/service';
import { respData, respErr } from '@/lib/resp';

async function GET({ request }: { request: Request }) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return respErr('Unauthorized', { status: 401 });
    }
    const configs = await getAllConfigs();
    await reconcileUserStorage(session.user.id, configs);
    return respData(await getUserStorage(session.user.id, configs));
  } catch (error) {
    return respErr(
      error instanceof Error ? error.message : 'Failed to load storage'
    );
  }
}

export const Route = createFileRoute('/api/storage')({
  server: { handlers: { GET } },
});
