import { describe, expect, it, vi } from "vitest";
import {
  actionItems,
  callSummary,
  firefliesClient,
  sentiment,
  transcriptLines,
  transcriptText,
  type FirefliesTranscript,
} from "./inbox-fireflies.js";
import { presignS3GetUrl } from "./inbox-recording-store.js";

const TRANSCRIPT: FirefliesTranscript = {
  id: "ff-1",
  sentences: [
    {
      index: 2,
      speaker_name: "Speaker 2",
      text: "Yes, two crates of zobo for Saturday.",
      start_time: 9.4,
      end_time: 12,
    },
    {
      index: 0,
      speaker_name: "Speaker 1",
      text: "Good afternoon, Mrs Samuel's.",
      start_time: 0.5,
      end_time: 2.1,
    },
    {
      index: 1,
      speaker_name: "Speaker 1",
      text: "How can I help?",
      start_time: "2.3",
      end_time: "3",
    },
    { index: 3, speaker_name: " ", text: "  ", start_time: 12, end_time: 13 },
  ],
  summary: {
    overview: "Customer ordered two crates of zobo for Saturday delivery.",
    gist: "Zobo order for Saturday",
    action_items:
      "**Speaker 1**\nSend the invoice to the customer (00:45)\n- Book Saturday delivery\n\n",
  },
  sentiments: { positive_pct: 60, neutral_pct: 35, negative_pct: 5 },
};

describe("Fireflies transcript → what the suite stores", () => {
  it("orders lines, keeps who spoke and when, and drops empty lines", () => {
    expect(transcriptLines(TRANSCRIPT)).toEqual([
      { speaker: "Speaker 1", text: "Good afternoon, Mrs Samuel's.", start_s: 0.5, end_s: 2.1 },
      { speaker: "Speaker 1", text: "How can I help?", start_s: 2.3, end_s: 3 },
      {
        speaker: "Speaker 2",
        text: "Yes, two crates of zobo for Saturday.",
        start_s: 9.4,
        end_s: 12,
      },
    ]);
  });

  it("joins one speaker's lines into a turn for the plain-text transcript", () => {
    expect(transcriptText(transcriptLines(TRANSCRIPT))).toBe(
      "Speaker 1: Good afternoon, Mrs Samuel's. How can I help?\nSpeaker 2: Yes, two crates of zobo for Saturday.",
    );
  });

  it("splits action items into one per line without headings, bullets or timestamps", () => {
    expect(actionItems(TRANSCRIPT.summary!.action_items)).toEqual([
      "Send the invoice to the customer",
      "Book Saturday delivery",
    ]);
    expect(actionItems(["1. Call back", "  "])).toEqual(["Call back"]);
    expect(actionItems(null)).toEqual([]);
  });

  it("picks the strongest mood, neutral when unknown or tied", () => {
    expect(sentiment({ positive_pct: 60, neutral_pct: 35, negative_pct: 5 })).toBe("positive");
    expect(sentiment({ positive_pct: 10, neutral_pct: 20, negative_pct: 70 })).toBe("negative");
    expect(sentiment({ positive_pct: 40, neutral_pct: 20, negative_pct: 40 })).toBe("neutral");
    expect(sentiment(null)).toBe("neutral");
  });

  it("maps the summary into the suite's summary shape", () => {
    expect(callSummary(TRANSCRIPT)).toEqual({
      summary: "Customer ordered two crates of zobo for Saturday delivery.",
      call_reason: "Zobo order for Saturday",
      action_items: ["Send the invoice to the customer", "Book Saturday delivery"],
      sentiment: "positive",
    });
  });

  it("has no summary until Fireflies has written one", () => {
    expect(callSummary({ id: "x", summary: { overview: "", gist: null } })).toBeNull();
    expect(callSummary({ id: "x", summary: null })).toBeNull();
  });
});

function gqlResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Fireflies client", () => {
  it("uploads with our recording id, a Bearer key and the small-file bypass", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        gqlResponse({ data: { uploadAudio: { success: true, title: "t", message: "queued" } } }),
      );
    await firefliesClient("test-key", fetchMock).uploadAudio({
      url: "https://r2.example/x.mp3?sig",
      title: "Mrs Samuel call",
      clientReferenceId: "rec-1",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.fireflies.ai/graphql");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    const sent = JSON.parse(init.body as string);
    expect(sent.query).toContain("uploadAudio");
    expect(sent.variables.input).toEqual({
      url: "https://r2.example/x.mp3?sig",
      title: "Mrs Samuel call",
      client_reference_id: "rec-1",
      bypass_size_check: true,
    });
  });

  it("treats a refused upload and a GraphQL error as failures", async () => {
    const refused = vi
      .fn()
      .mockResolvedValue(
        gqlResponse({ data: { uploadAudio: { success: false, message: "quota" } } }),
      );
    await expect(
      firefliesClient("k", refused).uploadAudio({ url: "u", title: "t", clientReferenceId: "r" }),
    ).rejects.toThrow(/quota/);

    const errored = vi
      .fn()
      .mockResolvedValue(
        gqlResponse({ errors: [{ message: "Pro plan required", code: "paid_required" }] }),
      );
    await expect(
      firefliesClient("k", errored).uploadAudio({ url: "u", title: "t", clientReferenceId: "r" }),
    ).rejects.toThrow(/paid_required: Pro plan required/);
  });

  it("returns the transcript even when sentiment is not on the plan", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        gqlResponse({
          data: { transcript: { id: "ff-1", sentences: [], summary: { overview: "Hi" } } },
        }),
      )
      .mockResolvedValueOnce(gqlResponse({ errors: [{ message: "Pro plan required" }] }));
    const t = await firefliesClient("k", fetchMock).getTranscript("ff-1");
    expect(t).toEqual({ id: "ff-1", sentences: [], summary: { overview: "Hi" }, sentiments: null });
  });

  it("returns null for an unknown transcript", async () => {
    const fetchMock = vi.fn().mockResolvedValue(gqlResponse({ data: { transcript: null } }));
    expect(await firefliesClient("k", fetchMock).getTranscript("nope")).toBeNull();
  });
});

describe("signed download link", () => {
  it("matches AWS's published Signature V4 presigned GET example", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = presignS3GetUrl({
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresInS: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });
});
