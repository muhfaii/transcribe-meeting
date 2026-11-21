// Fake Qwen for local development and tests (QWEN_MOCK=1). A task "finishes" 5 s after submit.
export const MOCK_URL_PREFIX = "mock://";
const MOCK_DELAY_MS = 5000;

export const mockTaskId = () => `mock-${Date.now()}`;

export function mockTaskResponse(taskId: string) {
  const submitted = Number(taskId.replace("mock-", ""));
  if (!Number.isFinite(submitted) || Date.now() - submitted < MOCK_DELAY_MS) {
    return { output: { task_id: taskId, task_status: "RUNNING" } };
  }
  return {
    usage: { duration: 12 },
    output: {
      task_id: taskId,
      task_status: "SUCCEEDED",
      results: [{ subtask_status: "SUCCEEDED", transcription_url: `${MOCK_URL_PREFIX}sample` }],
    },
  };
}

export const MOCK_RESULT = {
  properties: { channels: [0], original_duration_in_milliseconds: 12000 },
  transcripts: [
    {
      channel_id: 0,
      content_duration_in_milliseconds: 11000,
      text: "Selamat pagi semuanya. Let's start the weekly sync. 好的，我们开始。",
      sentences: [
        { begin_time: 500, end_time: 3200, text: "Selamat pagi semuanya.", sentence_id: 1, speaker_id: 0 },
        { begin_time: 3400, end_time: 6800, text: "Let's start the weekly sync.", sentence_id: 2, speaker_id: 1 },
        { begin_time: 7000, end_time: 11500, text: "好的，我们开始。", sentence_id: 3, speaker_id: 0 },
      ],
    },
  ],
};

/** Fake chat reply for the correction pass: capitalises "weekly sync" so the change is visible. */
export function mockCorrectionReply(userContent: string): string {
  const marker = "Transcript items (JSON):\n";
  const at = userContent.indexOf(marker);
  const items = at >= 0 ? (JSON.parse(userContent.slice(at + marker.length)) as { i: number; text: string }[]) : [];
  return JSON.stringify({ items: items.map((it) => ({ i: it.i, text: it.text.replace(/weekly sync/gi, "Weekly Sync") })) });
}
