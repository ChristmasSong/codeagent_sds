import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiGet } from '@/lib/api-client';
import {
  nextWorkspaceStatusPollState,
  shouldConfirmWorkspaceStatus,
  workspaceStatusPollInterval,
  type WorkspaceDirectoryResult,
  type WorkspaceFileContentResult,
  type WorkspaceStatusPollState,
  type WorkspaceStatusPollTarget,
  type WorkspaceStatusResult,
} from '@/lib/code-files';
import {
  downloadSandboxArchive,
  uploadSandboxFile,
} from '@/lib/sandbox-file-transfer';

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

export function useSandboxFileUpload(sessionId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (options: {
      file: File;
      path: string;
      signal?: AbortSignal;
    }) => {
      if (!sessionId) throw new Error('session_not_available');
      return uploadSandboxFile({ sessionId, ...options });
    },
    onSuccess: async () => {
      if (!sessionId) return;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['code-files', sessionId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['code-workspace-status', sessionId],
        }),
      ]);
    },
  });
}

export function useSandboxDownloadAll(sessionId: string | null) {
  return useMutation({
    mutationFn: () => {
      if (!sessionId) throw new Error('session_not_available');
      downloadSandboxArchive(sessionId);
      return Promise.resolve();
    },
  });
}

export function useWorkspaceStatus(sessionId: string | null, enabled: boolean) {
  const queryClient = useQueryClient();
  const previousDigests = useRef(new Map<string, string | null>());
  const pollStates = useRef(new Map<string, WorkspaceStatusPollState>());
  const previousTarget = useRef<WorkspaceStatusPollTarget>({
    sessionId: null,
    enabled: false,
  });
  const statusQuery = useQuery({
    queryKey: ['code-workspace-status', sessionId],
    queryFn: async () => {
      const result = await apiGet<WorkspaceStatusResult>(
        filesEndpoint(sessionId!, { operation: 'status' })
      );
      pollStates.current.set(
        sessionId!,
        nextWorkspaceStatusPollState(
          pollStates.current.get(sessionId!),
          sessionId!,
          result
        )
      );
      return result;
    },
    enabled: Boolean(sessionId && enabled),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (query.state.status === 'error') return 120_000;
      if (data?.sessionStatus && data.sessionStatus !== 'active') {
        return 120_000;
      }
      const stableChecks = sessionId
        ? (pollStates.current.get(sessionId)?.stableChecks ?? 0)
        : 0;
      return workspaceStatusPollInterval(stableChecks);
    },
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    retry: 1,
  });

  const statusRefetch = statusQuery.refetch;
  useEffect(() => {
    const nextTarget = {
      sessionId,
      enabled: Boolean(sessionId && enabled),
    };
    const previous = previousTarget.current;
    previousTarget.current = nextTarget;

    const shouldConfirm = shouldConfirmWorkspaceStatus(previous, nextTarget);
    if (shouldConfirm && statusQuery.fetchStatus !== 'fetching') {
      void statusRefetch();
    }
  }, [enabled, sessionId, statusQuery.fetchStatus, statusRefetch]);

  useEffect(() => {
    const digest = statusQuery.data?.digest;
    if (digest === undefined || !sessionId) return;
    const previousDigest = previousDigests.current.get(sessionId);
    if (previousDigest !== undefined && previousDigest !== digest) {
      void queryClient.invalidateQueries({
        queryKey: ['code-files', sessionId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['code-file-content', sessionId],
      });
    }
    previousDigests.current.set(sessionId, digest);
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
      statusRefetch(),
    ]);
  }, [queryClient, sessionId, statusRefetch]);

  return { ...statusQuery, refresh };
}
