// Prints a temporary (1h) download URL for an object in your R2 bucket, for scripts/qwen-probe.sh.
//   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
//   node scripts/presign-get.mjs probe/clip.m4a [bucket] [seconds]
import { AwsClient } from "aws4fetch";

const [key, bucket = "transcribe-meeting-media", seconds = "3600"] = process.argv.slice(2);
const { R2_ACCOUNT_ID: acct, R2_ACCESS_KEY_ID: id, R2_SECRET_ACCESS_KEY: secret } = process.env;
if (!key || !acct || !id || !secret) {
  console.error("usage: R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… node scripts/presign-get.mjs <key> [bucket] [seconds]");
  process.exit(1);
}
const client = new AwsClient({ accessKeyId: id, secretAccessKey: secret, service: "s3", region: "auto" });
const url = new URL(`https://${acct}.r2.cloudflarestorage.com/${bucket}/${key}`);
url.searchParams.set("X-Amz-Expires", seconds);
console.log((await client.sign(new Request(url), { aws: { signQuery: true } })).url);
