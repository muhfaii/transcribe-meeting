import { describe, expect, it } from "vitest";
import { createR2Client, presignPartUrl } from "../src/worker/r2presign";
import type { Env } from "../src/worker/env";

describe("presignPartUrl", () => {
  it("produces a signed S3 URL for one multipart part", async () => {
    const env = {
      R2_ACCOUNT_ID: "acct123",
      R2_ACCESS_KEY_ID: "AKIATEST",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET: "media",
    } as Env;
    const url = new URL(
      await presignPartUrl(createR2Client(env), {
        accountId: "acct123",
        bucket: "media",
        key: "uploads/123e4567-e89b-12d3-a456-426614174000.m4a",
        uploadId: "up-1",
        partNumber: 3,
        expiresIn: 600,
      }),
    );
    expect(url.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/media/uploads/123e4567-e89b-12d3-a456-426614174000.m4a");
    expect(url.searchParams.get("partNumber")).toBe("3");
    expect(url.searchParams.get("uploadId")).toBe("up-1");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("X-Amz-Credential")).toContain("AKIATEST/");
  });
});
