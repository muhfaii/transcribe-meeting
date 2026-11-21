import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

export function hasR2Credentials(env: Env): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

export function createR2Client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    service: "s3",
    region: "auto",
  });
}

/** Presigned PUT URL for one multipart part, straight to R2's S3 endpoint. */
export async function presignPartUrl(
  client: AwsClient,
  opts: {
    accountId: string;
    bucket: string;
    key: string;
    uploadId: string;
    partNumber: number;
    expiresIn?: number;
  },
): Promise<string> {
  const url = new URL(`https://${opts.accountId}.r2.cloudflarestorage.com/${opts.bucket}/${opts.key}`);
  url.searchParams.set("partNumber", String(opts.partNumber));
  url.searchParams.set("uploadId", opts.uploadId);
  url.searchParams.set("X-Amz-Expires", String(opts.expiresIn ?? 3600));
  const signed = await client.sign(new Request(url, { method: "PUT" }), {
    aws: { signQuery: true },
  });
  return signed.url;
}
