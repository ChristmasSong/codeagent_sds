import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import {
  assertSameOriginRequest,
  getWorkspaceDownloadAllResponse,
  getWorkspaceFileContent,
  getWorkspaceFileRawResponse,
  getWorkspaceStatus,
  listWorkspaceDirectory,
  uploadWorkspaceFile,
  WorkspaceFilesError,
  type WorkspaceRuntimeSecretResolver,
} from '@/modules/code/files';
import { getCodeStorageSettings } from '@/modules/code/storage';
import { getAllConfigs } from '@/modules/config/service';
import { respData, respErr } from '@/lib/resp';

const resolveRuntimeSecret: WorkspaceRuntimeSecretResolver = async (
  options
) => {
  const configs = await getAllConfigs(options);
  return configs.billing_usage_webhook_secret;
};

async function currentUser(request: Request) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) throw new Error('Unauthorized');
  return session.user;
}

function privateNoStore(response: Response) {
  response.headers.set('cache-control', 'private, no-store');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}

async function GET({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  try {
    const user = await currentUser(request);
    const url = new URL(request.url);
    const showHidden = url.searchParams.get('showHidden') === 'true';
    const operation = url.searchParams.get('operation');
    if (operation === 'status') {
      return privateNoStore(
        respData(
          await getWorkspaceStatus(
            user.id,
            params.id,
            showHidden,
            resolveRuntimeSecret
          )
        )
      );
    }
    if (operation === 'content') {
      const path = url.searchParams.get('path') || '';
      if (url.searchParams.get('raw') === 'true') {
        return getWorkspaceFileRawResponse(
          user.id,
          params.id,
          path,
          resolveRuntimeSecret
        );
      }
      return privateNoStore(
        respData(
          await getWorkspaceFileContent(
            user.id,
            params.id,
            path,
            resolveRuntimeSecret
          )
        )
      );
    }
    if (operation === 'download-all') {
      return getWorkspaceDownloadAllResponse(
        user.id,
        params.id,
        resolveRuntimeSecret
      );
    }
    if (operation) {
      throw new WorkspaceFilesError('invalid_operation', 400);
    }
    return privateNoStore(
      respData(
        await listWorkspaceDirectory(
          user.id,
          params.id,
          url.searchParams.get('path') || '',
          showHidden,
          resolveRuntimeSecret
        )
      )
    );
  } catch (error: unknown) {
    const isUnauthorized =
      error instanceof Error && error.message === 'Unauthorized';
    const status =
      error instanceof WorkspaceFilesError
        ? error.status
        : isUnauthorized
          ? 401
          : 500;
    const message =
      error instanceof WorkspaceFilesError
        ? error.message
        : isUnauthorized
          ? 'unauthorized'
          : 'workspace_request_failed';
    return privateNoStore(respErr(message, { status }));
  }
}

async function PUT({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  try {
    const user = await currentUser(request);
    assertSameOriginRequest(request);
    const url = new URL(request.url);
    if (url.searchParams.get('operation') !== 'upload') {
      throw new WorkspaceFilesError('invalid_operation', 400);
    }
    const configs = await getAllConfigs();
    const result = await uploadWorkspaceFile(
      user.id,
      params.id,
      url.searchParams.get('path') || '',
      request.body,
      request.headers,
      getCodeStorageSettings(configs).workspaceQuotaBytes,
      resolveRuntimeSecret
    );
    return privateNoStore(respData(result));
  } catch (error: unknown) {
    await request.body?.cancel().catch(() => undefined);
    const isUnauthorized =
      error instanceof Error && error.message === 'Unauthorized';
    const status =
      error instanceof WorkspaceFilesError
        ? error.status
        : isUnauthorized
          ? 401
          : 500;
    const message =
      error instanceof WorkspaceFilesError
        ? error.message
        : isUnauthorized
          ? 'unauthorized'
          : 'workspace_request_failed';
    return privateNoStore(respErr(message, { status }));
  }
}

export const Route = createFileRoute('/api/code/sessions/$id/files')({
  server: {
    handlers: { GET, PUT },
  },
});
