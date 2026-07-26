import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { apiGet } from '@/lib/api-client';
import {
  workspaceStatusPollInterval,
  type WorkspaceDirectoryResult,
  type WorkspaceFileContentResult,
  type WorkspaceStatusResult,
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
  const previousStatus = useRef<{
    sessionId: string | null;
    digest: string | null | undefined;
  }>({ sessionId: null, digest: undefined });
  const pollState = useRef<{
    sessionId: string | null;
    digest: string | null | undefined;
    stableChecks: number;
  }>({ sessionId: null, digest: undefined, stableChecks: 0 });
  const statusQuery = useQuery({
    queryKey: ['code-workspace-status', sessionId],
    queryFn: async () => {
      const result = await apiGet<WorkspaceStatusResult>(
        filesEndpoint(sessionId!, { operation: 'status' })
      );
      const previous = pollState.current;
      if (previous.sessionId !== sessionId) {
        pollState.current = {
          sessionId,
          digest: result.digest,
          stableChecks: 0,
        };
      } else if (previous.digest === result.digest) {
        pollState.current = {
          ...previous,
          stableChecks: previous.stableChecks + 1,
        };
      } else {
        pollState.current = {
          sessionId,
          digest: result.digest,
          stableChecks: 0,
        };
      }
      return result;
    },
    enabled: Boolean(sessionId && enabled),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.sessionStatus && data.sessionStatus !== 'active') return false;
      if (query.state.status === 'error') return 120_000;
      return workspaceStatusPollInterval(pollState.current.stableChecks);
    },
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    retry: 1,
  });

  useEffect(() => {
    const digest = statusQuery.data?.digest;
    if (digest === undefined) return;
    const previous = previousStatus.current;
    if (
      previous.sessionId === sessionId &&
      previous.digest !== undefined &&
      previous.digest !== digest &&
      sessionId
    ) {
      void queryClient.invalidateQueries({
        queryKey: ['code-files', sessionId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['code-file-content', sessionId],
      });
    }
    previousStatus.current = { sessionId, digest };
  }, [queryClient, sessionId, statusQuery.data?.digest]);

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
