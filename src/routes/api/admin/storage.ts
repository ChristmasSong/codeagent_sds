import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import {
  getAdminStorageMetrics,
  reconcilePlatformStorageBytes,
} from '@/modules/code/storage';
import { getRuntimeArchiveStats } from '@/modules/code/storage-runtime';
import { getAllConfigs } from '@/modules/config/service';
import { hasPermission } from '@/modules/rbac/service';
import { respData, respErr } from '@/lib/resp';

async function GET({ request }: { request: Request }) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return respErr('Unauthorized', { status: 401 });
    }
    if (!(await hasPermission(session.user.id, 'admin.*'))) {
      return respErr('Forbidden', { status: 403 });
    }
    const url = new URL(request.url);
    const days = Number.parseInt(url.searchParams.get('days') || '30', 10);
    const top = Number.parseInt(url.searchParams.get('top') || '10', 10);
    const configs = await getAllConfigs();
    let physicalObjectCount: number | undefined;
    try {
      const physical = await getRuntimeArchiveStats();
      await reconcilePlatformStorageBytes(physical.bytes, physical.objects);
      physicalObjectCount = physical.objects;
    } catch (error) {
      console.warn('[storage-monitor] R2 reconciliation failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return respData(
      await getAdminStorageMetrics(configs, {
        days,
        top,
        physicalObjectCount,
      })
    );
  } catch (error) {
    return respErr(
      error instanceof Error ? error.message : 'Failed to load storage metrics'
    );
  }
}

export const Route = createFileRoute('/api/admin/storage')({
  server: { handlers: { GET } },
});
