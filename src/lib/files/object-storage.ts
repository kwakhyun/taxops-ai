import "server-only";

import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { quarantineObjectKey } from "@/lib/files/object-key";
import { isPortfolioDemo } from "@/lib/runtime/portfolio-demo";

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
  checksum: string;
}

declare global {
  var __taxopsDemoObjects: Map<string, StoredObject> | undefined;
}

function demoObjects() {
  globalThis.__taxopsDemoObjects ??= new Map();
  return globalThis.__taxopsDemoObjects;
}

let s3Client: S3Client | undefined;

function getS3Client() {
  s3Client ??= new S3Client({
    region: process.env.AWS_REGION ?? "ap-northeast-2",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });
  return s3Client;
}

export interface StoredObjectHandle {
  objectKey: string;
  objectVersionId?: string;
  objectEtag?: string;
  objectChecksumSha256?: string;
  cleanup: () => Promise<void>;
}

export async function putQuarantinedObject(input: {
  tenantId: string;
  matterId: string;
  bytes: Uint8Array;
  contentType: string;
  checksum: string;
}): Promise<StoredObjectHandle> {
  // An attempt owns its object. Cleaning up an idempotent retry must not remove
  // the original object referenced by the already persisted document.
  const key = quarantineObjectKey(input);
  const bucket = process.env.OBJECT_BUCKET;

  if (!bucket) {
    if (process.env.NODE_ENV === "production" && !isPortfolioDemo()) {
      throw new Error("OBJECT_BUCKET is required in production");
    }
    demoObjects().set(key, {
      bytes: input.bytes.slice(),
      contentType: input.contentType,
      checksum: input.checksum,
    });
    return {
      objectKey: `memory://${key}`,
      cleanup: async () => {
        demoObjects().delete(key);
      },
    };
  }

  const encryption = process.env.S3_ENDPOINT
    ? undefined
    : process.env.S3_KMS_KEY_ID
      ? "aws:kms"
      : "AES256";
  const stored = await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: input.bytes,
      ContentType: input.contentType,
      ChecksumSHA256: Buffer.from(input.checksum, "hex").toString("base64"),
      ServerSideEncryption: encryption,
      SSEKMSKeyId: process.env.S3_KMS_KEY_ID,
      Metadata: { lifecycle: "quarantine", sha256: input.checksum },
      Tagging: "lifecycle=quarantine",
    }),
  );
  if (!stored.VersionId) {
    throw new Error("Object bucket versioning is required for uploads");
  }
  if (!stored.ETag) {
    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: stored.VersionId,
      }),
    );
    throw new Error("Object storage did not return an ETag for the upload");
  }

  return {
    objectKey: `s3://${bucket}/${key}`,
    objectVersionId: stored.VersionId,
    objectEtag: stored.ETag,
    objectChecksumSha256: input.checksum,
    cleanup: async () => {
      await getS3Client().send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
          VersionId: stored.VersionId,
        }),
      );
    },
  };
}
