import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { apiGet } from '@/lib/api-client';
import type {
  WorkspaceDirectoryResult,
  WorkspaceFileContentResult,
  WorkspaceStatusResult,
} from '@/lib/code-files';

function filesEndpoint(sessionId: string, params: Record<string, string> = {}) {
  const search = new URLSearchParams(params);
  const query = search.toString();
  return `/api/code/sessions/${encodeURIComponent(sessionId)}/files${query ? `?${query}` : ''}`;
}

export function useSandboxDirectory(
  sessionId: string | null,
  path: string,
  enabled: boolean
) {
  return useQuery({
    queryKey: ['code-files', sessionId, path],
    queryFn: () =>
      apiGet<WorkspaceDirectoryResult>(
        filesEndpoint(sessionId!, path ? { path } : {})
      ),
    enabled: Boolean(sessionId && enabled),
    staleTime: 2_000,
    retry: 1,
  });
}

export function useSandboxFileContent(
  sessionId: string | null,
  path: string,
  enabled: boolean
) {
  return useQuery({
    queryKey: ['code-file-content', sessionId, path],
    queryFn: () =>
      apiGet<WorkspaceFileContentResult>(
        filesEndpoint(sessionId!, { operation: 'content', path })
      ),
    enabled: Boolean(sessionId && path && enabled),
    staleTime: 2_000,
    retry: 1,
  });
}

export function sandboxFileRawUrl(
  sessionId: string,
  path: string,
  etag?: string
) {
  return filesEndpoint(sessionId, {
    operation: 'content',
    path,
    raw: 'true',
    ...(etag ? { v: etag } : {}),
  });
}

export function useWorkspaceStatus(sessionId: string | null, enabled: boolean) {
  const queryClient = useQueryClient();
  const previousDigest = useRef<string | null | undefined>(undefined);
  const statusQuery = useQuery({
    queryKey: ['code-workspace-status', sessionId],
    queryFn: () =>
      apiGet<WorkspaceStatusResult>(
        filesEndpoint(sessionId!, { operation: 'status' })
      ),
    enabled: Boolean(sessionId && enabled),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.sessionStatus && data.sessionStatus !== 'active'
        ? false
        : 3_000;
    },
    refetchIntervalInBackground: false,
    retry: 1,
  });

  useEffect(() => {
    const digest = statusQuery.data?.digest;
    if (digest === undefined) return;
    if (
      previousDigest.current !== undefined &&
      previousDigest.current !== digest &&
      sessionId
    ) {
      void queryClient.invalidateQueries({
        queryKey: ['code-files', sessionId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['code-file-content', sessionId],
      });
    }
    previousDigest.current = digest;
  }, [queryClient, sessionId, statusQuery.data?.digest]);

  useEffect(() => {
    previousDigest.current = undefined;
  }, [sessionId]);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['code-files', sessionId],
      }),
      queryClient.invalidateQueries({
        queryKey: ['code-file-content', sessionId],
      }),
      statusQuery.refetch(),
    ]);
  }, [queryClient, sessionId, statusQuery]);

  return { ...statusQuery, refresh };
}
