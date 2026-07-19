import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Validated lazily (not at module load) so builds work before R2 is configured.
function getConfig() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME",
    );
  }

  return { accountId, accessKeyId, secretAccessKey, bucket };
}

let client: S3Client | null = null;

function getClient() {
  if (!client) {
    const { accountId, accessKeyId, secretAccessKey } = getConfig();
    client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return client;
}

/** Presigned PUT so the browser uploads audio directly to R2 (15 min validity). */
export function presignUpload(objectKey: string, contentType: string) {
  const { bucket } = getConfig();
  return getSignedUrl(
    getClient(),
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ContentType: contentType,
    }),
    { expiresIn: 60 * 15 },
  );
}

/** Presigned GET for playback of a stored client track (1 h validity). */
export function presignPlayback(objectKey: string) {
  const { bucket } = getConfig();
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    { expiresIn: 60 * 60 },
  );
}
