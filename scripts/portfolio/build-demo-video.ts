import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve("artifacts/portfolio");
const raw = resolve(directory, "raw");
const font =
  process.env.PORTFOLIO_FONT_PATH ??
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";
type Recording = {
  name: string;
  completed: boolean;
  viewport: { width: number; height: number };
  cues: Array<{ atMs: number; title: string; description: string }>;
  pageErrors: string[];
};
const escapeFilterPath = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
const probe = (path: string) =>
  JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        path,
      ],
      { encoding: "utf8" },
    ),
  ) as {
    format: { duration: string; size: string };
    streams: Array<{ codec_name: string; width: number; height: number }>;
  };
await mkdir(raw, { recursive: true });
await writeFile(
  resolve(raw, "footer.txt"),
  "TaxOps AI  |  개인 포트폴리오  |  합성 자료 / 실제 UI 녹화 / 무음 시연\n",
);
const chapters = [];
let offsetSeconds = 0;
for (const name of ["desktop", "mobile"]) {
  const recording = JSON.parse(
    await readFile(resolve(raw, `${name}.json`), "utf8"),
  ) as Recording;
  if (!recording.completed || recording.pageErrors.length)
    throw new Error(`Unverified recording: ${name}`);
  const input = resolve(raw, `${name}.webm`);
  const duration = Number(probe(input).format.duration);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("Invalid recording duration");
  const mobile = name === "mobile";
  const filters = [
    mobile ? "scale=480:800:flags=lanczos" : "scale=1280:800:flags=lanczos",
    "pad=1440:1080:(ow-iw)/2:116:color=0x23242e",
    "drawbox=x=48:y=27:w=48:h=5:color=0xffe600:t=fill",
    `drawtext=fontfile='${escapeFilterPath(font)}':textfile='${escapeFilterPath(resolve(raw, "footer.txt"))}':fontcolor=0xbfc0c9:fontsize=18:x=48:y=1031`,
  ];
  for (const [index, cue] of recording.cues.entries()) {
    const start = Math.max(0, cue.atMs / 1000);
    const end = recording.cues[index + 1]
      ? recording.cues[index + 1]!.atMs / 1000
      : duration;
    const titlePath = resolve(raw, `${name}-${index}-title.txt`);
    const descriptionPath = resolve(raw, `${name}-${index}-description.txt`);
    // Caption files avoid inserting text into ffmpeg expressions or shell commands.
    await writeFile(titlePath, cue.title);
    const words = cue.description.split(" ");
    const lines = [""];
    for (const word of words) {
      if (lines[lines.length - 1]!.length + word.length > 54) lines.push("");
      lines[lines.length - 1] += (lines[lines.length - 1] ? " " : "") + word;
    }
    await writeFile(descriptionPath, lines.join("\n"));
    const enabled = `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
    filters.push(
      `drawtext=fontfile='${escapeFilterPath(font)}':textfile='${escapeFilterPath(titlePath)}':fontcolor=white:fontsize=28:x=48:y=53:${enabled}`,
    );
    filters.push(
      `drawtext=fontfile='${escapeFilterPath(font)}':textfile='${escapeFilterPath(descriptionPath)}':fontcolor=0xe5e5eb:fontsize=24:line_spacing=8:x=48:y=945:${enabled}`,
    );
    chapters.push({
      startSeconds: Number((offsetSeconds + start).toFixed(2)),
      title: cue.title,
      description: cue.description,
    });
  }
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input,
      "-vf",
      filters.join(","),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "19",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "25",
      "-threads",
      "2",
      "-movflags",
      "+faststart",
      resolve(raw, `${name}.mp4`),
    ],
    { stdio: "inherit" },
  );
  offsetSeconds += duration;
}
const list = resolve(raw, "concat.txt");
await writeFile(
  list,
  ["desktop", "mobile"]
    .map(
      (name) =>
        `file '${resolve(raw, `${name}.mp4`).replaceAll("'", "'\\''")}'`,
    )
    .join("\n") + "\n",
);
const output = resolve(directory, "taxops-ai-demo.mp4");
execFileSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    output,
  ],
  { stdio: "inherit" },
);
const media = probe(output);
await writeFile(
  resolve(directory, "demo-manifest.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      source: "tests/portfolio/role-demo.spec.ts",
      viewportDesktop: "1280x800",
      viewportMobile: "390x650",
      video: "taxops-ai-demo.mp4",
      seconds: Number(media.format.duration),
      bytes: Number(media.format.size),
      width: media.streams[0]?.width,
      height: media.streams[0]?.height,
      disclosure:
        "Actual local UI recording, synthetic fixtures, deterministic AI, seeded workpaper approval, test-role authentication, no audio.",
      chapters,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    { output, seconds: media.format.duration, bytes: media.format.size },
    null,
    2,
  ),
);
