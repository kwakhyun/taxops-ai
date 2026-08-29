import { S3Client } from "@aws-sdk/client-s3";

let s3Client: S3Client | undefined;

export function getS3Client() {
  s3Client ??= new S3Client({
    region: process.env.AWS_REGION ?? "ap-northeast-2",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });
  return s3Client;
}

export function parseS3Uri(uri: string) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match?.[1] || !match[2]) {
    throw Object.assign(new Error("Document object key is not an S3 URI"), {
      permanent: true,
    });
  }
  if (process.env.OBJECT_BUCKET && match[1] !== process.env.OBJECT_BUCKET) {
    throw Object.assign(
      new Error("Document object points outside the configured bucket"),
      { permanent: true },
    );
  }
  return { bucket: match[1], key: match[2] };
}

export function encodedCopySource(
  bucket: string,
  key: string,
  versionId: string,
) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${bucket}/${encodedKey}?versionId=${encodeURIComponent(versionId)}`;
}

export function cleanObjectKey(key: string) {
  if (key.includes("/clean/")) return key;
  if (!key.includes("/quarantine/")) {
    throw Object.assign(
      new Error("Document is outside a managed object tier"),
      {
        permanent: true,
      },
    );
  }
  return key.replace("/quarantine/", "/clean/");
}
