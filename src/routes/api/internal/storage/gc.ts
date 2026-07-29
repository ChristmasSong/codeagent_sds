import { createFileRoute } from '@tanstack/react-router';

import { envConfigs } from '@/config';
import {
  planStorageGc,
  settleConfirmedStorageGcDeletion,
  sweepStorageGc,
} from '@/modules/code/storage-gc';
import { getAllConfigs } from '@/modules/config/service';
import { respData, respErr } from '@/lib/resp';

const MAX_OBJECTS_PER_REQUEST = 250;

interface GcRequestObject {
  key?: unknown;
  size?: unknown;
  uploaded?: unknown;
  etag?: unknown;
  customMetadata?: unknown;
}

function runtimeSecret(configs: Record<string, string>) {
  return (
    configs.billing_usage_webhook_secret ||
    envConfigs.billing_usage_webhook_secret ||
    ''
  ).trim();
}

function physicalObjects(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_OBJECTS_PER_REQUEST) {
    throw new Error('Invalid storage GC object batch');
  }
  return value.map((raw) => {
    const object = raw as GcRequestObject;
    const size = Number(object.size);
    if (
      typeof object.key !== 'string' ||
      !object.key ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      typeof object.uploaded !== 'string' ||
      !object.uploaded
    ) {
      throw new Error('Invalid storage GC object');
    }
    const customMetadata =
      object.customMetadata &&
      typeof object.customMetadata === 'object' &&
      !Array.isArray(object.customMetadata)
        ? Object.fromEntries(
            Object.entries(object.customMetadata).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : undefined;
    return {
      key: object.key,
      size,
      uploaded: object.uploaded,
      ...(typeof object.etag === 'string' ? { etag: object.etag } : {}),
      ...(customMetadata ? { customMetadata } : {}),
    };
  });
}

function confirmedKeys(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_OBJECTS_PER_REQUEST) {
    throw new Error('Invalid storage GC confirmation batch');
  }
  if (!value.every((key) => typeof key === 'string' && key.length > 0)) {
    throw new Error('Invalid storage GC confirmation key');
  }
  return value as string[];
}

async function POST({ request }: { request: Request }) {
  try {
    const configs = await getAllConfigs();
    const expectedSecret = runtimeSecret(configs);
    const providedSecret = request.headers.get('x-hicode-runtime-secret') || '';
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return respErr('Unauthorized', { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      objects?: unknown;
      confirmedAbsentKeys?: unknown;
    } | null;
    if (!body) return respErr('Invalid JSON', { status: 400 });

    if (body.action === 'plan') {
      return respData(
        await planStorageGc({
          objects: physicalObjects(body.objects),
          configs,
        })
      );
    }
    if (body.action === 'sweep') {
      return respData(
        await sweepStorageGc({
          objects: physicalObjects(body.objects),
          configs,
        })
      );
    }
    if (body.action === 'confirm') {
      return respData(
        await settleConfirmedStorageGcDeletion(
          confirmedKeys(body.confirmedAbsentKeys)
        )
      );
    }
    return respErr('Unsupported storage GC action', { status: 400 });
  } catch (error) {
    return respErr(
      error instanceof Error ? error.message : 'Storage GC failed',
      { status: 500 }
    );
  }
}

export const Route = createFileRoute('/api/internal/storage/gc')({
  server: { handlers: { POST } },
});
