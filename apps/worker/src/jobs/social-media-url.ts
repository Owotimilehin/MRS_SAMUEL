/**
 * Links Meta can fetch a post's picture or video from (suite spec 09, section 6.4).
 *
 * Meta downloads the file itself (I3), so it is handed a signed GET link that works for
 * one hour. A link is made at the moment of each call and never stored (rule 12).
 *
 * Settings read: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SOCIAL_MEDIA_KEY_RE } from "@ms/shared";

const LINK_SECONDS = 3600;

/**
 * A function that signs a GET link Meta can fetch for 1 hour, or null when R2 is not
 * configured (then posts with pictures or videos fail with a plain message; text and
 * link posts still publish). The function refuses any key that is not a post file.
 */
export function socialUrlSignerFromEnv(source: NodeJS.ProcessEnv = process.env): ((key: string) => Promise<string>) | null {
  const accountId = source.R2_ACCOUNT_ID;
  const accessKeyId = source.R2_ACCESS_KEY_ID;
  const secretAccessKey = source.R2_SECRET_ACCESS_KEY;
  const bucket = source.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return async (key: string) => {
    if (!key.startsWith("social/posts/") || !SOCIAL_MEDIA_KEY_RE.test(key)) throw new Error("not a post file");
    return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: LINK_SECONDS });
  };
}
