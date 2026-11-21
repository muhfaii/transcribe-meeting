import { describe, expect, it } from "vitest";
import { isUploadKey, partCount, PART_SIZE, validateUpload } from "../src/shared/upload-rules";

describe("validateUpload", () => {
  it("accepts m4a", () => {
    expect(validateUpload("meeting.m4a", 1000, "audio/x-m4a")).toBeNull();
    expect(validateUpload("Meeting.M4A", 1000, "")).toBeNull();
  });
  it("rejects mp4, wav and other files", () => {
    expect(validateUpload("a.mp4", 1000, "video/mp4")).not.toBeNull();
    expect(validateUpload("a.wav", 1000, "audio/wav")).not.toBeNull();
    expect(validateUpload("a.m4a", 1000, "video/mp4")).not.toBeNull();
  });
  it("rejects empty and oversized files", () => {
    expect(validateUpload("a.m4a", 0, "")).not.toBeNull();
    expect(validateUpload("a.m4a", 2000, "", 1000)).not.toBeNull();
  });
});

describe("partCount", () => {
  it("rounds up and is at least 1", () => {
    expect(partCount(1)).toBe(1);
    expect(partCount(PART_SIZE)).toBe(1);
    expect(partCount(PART_SIZE + 1)).toBe(2);
  });
});

describe("isUploadKey", () => {
  it("only matches generated upload keys", () => {
    expect(isUploadKey("uploads/123e4567-e89b-12d3-a456-426614174000.m4a")).toBe(true);
    expect(isUploadKey("uploads/../secret.m4a")).toBe(false);
    expect(isUploadKey("transcripts/x/raw.json")).toBe(false);
  });
});
