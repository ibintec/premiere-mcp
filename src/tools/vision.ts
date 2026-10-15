/**
 * Vision + title tools (Ibintec Premiere MCP additions).
 * Copyright (c) 2026 Ibintec Limited. MIT License, see LICENSE.md.
 *
 * The rest of this server can only return JSON text, so Claude can edit a
 * timeline but cannot SEE footage. These tools close that gap by returning
 * real images (MCP image content):
 *
 *   list_clips          - clips in a folder with durations
 *   view_clip           - contact sheet of a whole clip on disk
 *   view_moment         - close look at one section of a clip on disk
 *   view_timeline       - contact sheet of the EDIT itself (frames exported
 *                         from a Premiere sequence), so Claude can review its
 *                         own cut, e.g. the hook
 *   render_title_card   - renders an animated title (fade / slide) to a
 *                         transparent ProRes 4444 .mov for intros, returns a
 *                         preview image
 *
 * All frame work is done with ffmpeg/ffprobe, which must be on PATH.
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { basename, extname, isAbsolute, join } from 'node:path';
import type { MCPTool } from './index.js';

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface VisionToolResult {
  content: ToolContent[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Runs any other tool of this server (used to call export_frame). */
export type ToolRunner = (name: string, args: Record<string, any>) => Promise<any>;

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mxf', '.mts', '.m2ts', '.m4v', '.avi', '.mkv']);
const COLS = 4;
const MAX_FRAMES = 24;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

interface RunResult { code: number; stdout: Buffer; stderr: string }

function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { windowsHide: true, cwd });
    const out: Buffer[] = [];
    let err = '';
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('error', (e) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: e.message }));
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err }));
  });
}

async function ensureFfmpeg(): Promise<void> {
  const [a, b] = await Promise.all([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])]);
  if (a.code !== 0 || b.code !== 0) {
    throw new Error('ffmpeg/ffprobe were not found on PATH. On Windows run `winget install Gyan.FFmpeg`, then fully restart Claude Desktop.');
  }
}

async function probeDuration(path: string): Promise<number> {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path]);
  const d = parseFloat(r.stdout.toString().trim());
  if (!isFinite(d) || d <= 0) throw new Error(`Could not read the duration of ${path}. Is it a video file?`);
  return d;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Evenly spaced sample times: the middle of `n` equal slices of [start, end]. */
function sampleTimes(start: number, end: number, n: number): number[] {
  const step = (end - start) / n;
  return Array.from({ length: n }, (_, i) => start + step * (i + 0.5));
}

function clampFrames(n: number | undefined, dflt: number): number {
  return Math.max(1, Math.min(MAX_FRAMES, Math.round(n ?? dflt)));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pr-vision-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Runs async jobs with limited parallelism (keeps a laptop responsive). */
async function pool<T>(items: T[], limit: number, job: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await job(items[i] as T, i);
    }
  });
  await Promise.all(workers);
}

/** Grabs one frame per timestamp from a video file into dir/fNN.jpg. */
async function grabFrames(path: string, times: number[], width: number, dir: string): Promise<void> {
  await pool(times, 3, async (t, i) => {
    // -ss before -i: fast keyframe seek, then exact decode up to t
    const r = await run('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', path,
      '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4',
      join(dir, `f${String(i).padStart(2, '0')}.jpg`)]);
    if (r.code !== 0) throw new Error(`ffmpeg could not read a frame at ${fmt(t)}: ${r.stderr.slice(-400)}`);
  });
}

/** Tiles dir/fNN.<ext> (count frames) into one JPEG and returns its bytes. */
async function tile(dir: string, count: number, ext = 'jpg', width?: number): Promise<Buffer> {
  const cols = Math.min(COLS, count);
  const rows = Math.ceil(count / COLS);
  const out = join(dir, 'sheet.jpg');
  const scale = width ? `scale=${width}:-2,` : '';
  const r = await run('ffmpeg', ['-v', 'error', '-y', '-i', join(dir, `f%02d.${ext}`),
    '-vf', `${scale}tile=${cols}x${rows}:padding=4:color=black`, '-frames:v', '1', '-q:v', '4', out]);
  if (r.code !== 0 || !existsSync(out)) throw new Error(`ffmpeg could not build the contact sheet: ${r.stderr.slice(-400)}`);
  return fs.readFile(out);
}

function legend(label: string, times: number[]): string {
  const cols = Math.min(COLS, times.length);
  const lines = [`${label}: frames read left-to-right, top-to-bottom. Timestamps:`];
  times.forEach((t, i) => {
    lines.push(`  #${i + 1} (row ${Math.floor(i / cols) + 1}, col ${(i % cols) + 1}) at ${fmt(t)} (${t.toFixed(2)}s)`);
  });
  return lines.join('\n');
}

function image(buf: Buffer): ToolContent {
  return { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' };
}

function text(t: string): ToolContent {
  return { type: 'text', text: t };
}

function defaultFontFile(): string | undefined {
  const candidates = platform() === 'win32'
    ? ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/arial.ttf']
    : platform() === 'darwin'
      ? ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/Library/Fonts/Arial Bold.ttf', '/System/Library/Fonts/Helvetica.ttc']
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'];
  return candidates.find((c) => existsSync(c));
}

/** Accepts "white", "#F2C14E", "F2C14E", "0xF2C14E" and returns an ffmpeg colour. */
function ffColor(c: string): string {
  const s = c.trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(s)) return '0x' + s.replace('#', '');
  if (/^0x[0-9a-fA-F]{6}$/i.test(s)) return s;
  if (/^[a-zA-Z]+$/.test(s)) return s;
  throw new Error(`Unrecognised colour "${c}". Use a name like white or a hex code like #F2C14E.`);
}

// ---------------------------------------------------------------------------
// tool definitions
// ---------------------------------------------------------------------------

const schemas = {
  list_clips: z.object({
    folder: z.string().describe('Absolute path of a folder of video clips (proxies are faster than 4K originals)')
  }),
  view_clip: z.object({
    path: z.string().describe('Absolute path of the video file'),
    frames: z.number().int().min(1).max(MAX_FRAMES).optional().describe('How many evenly spaced frames to show (default 12, max 24). For 4-5 minute clips 16 is a good choice.'),
    width: z.number().int().min(160).max(960).optional().describe('Width of each frame in pixels (default 384)')
  }),
  view_moment: z.object({
    path: z.string().describe('Absolute path of the video file'),
    start: z.number().min(0).describe('Start of the section, in seconds'),
    end: z.number().describe('End of the section, in seconds'),
    frames: z.number().int().min(1).max(MAX_FRAMES).optional().describe('How many frames to show (default 8)'),
    width: z.number().int().min(160).max(960).optional().describe('Width of each frame in pixels (default 480)')
  }),
  view_timeline: z.object({
    sequenceId: z.string().describe('Sequence ID, as returned by list_sequences or get_active_sequence'),
    start: z.number().min(0).describe('Start of the range to review, in seconds of sequence time'),
    end: z.number().describe('End of the range to review, in seconds of sequence time'),
    frames: z.number().int().min(1).max(MAX_FRAMES).optional().describe('How many frames to show (default 8)'),
    width: z.number().int().min(160).max(960).optional().describe('Width of each frame in pixels (default 384)')
  }),
  render_title_card: z.object({
    title: z.string().min(1).max(80).describe('Main title text, e.g. the channel name'),
    subtitle: z.string().max(120).optional().describe('Optional second line, e.g. "Episode 5: Harvest Day". Appears just after the title.'),
    outputPath: z.string().describe('Absolute path for the .mov file to create'),
    animation: z.enum(['slide_up', 'slide_left', 'fade']).optional().describe('How the text enters and leaves (default slide_up)'),
    position: z.enum(['center', 'lower_third']).optional().describe('Where the text sits (default center)'),
    duration: z.number().min(1.5).max(15).optional().describe('Length in seconds (default 4)'),
    width: z.number().int().min(320).max(3840).optional().describe('Frame width; match the sequence (default 1920)'),
    height: z.number().int().min(240).max(2160).optional().describe('Frame height; match the sequence (default 1080)'),
    fps: z.number().min(10).max(60).optional().describe('Frame rate; match the sequence (default 25)'),
    textColor: z.string().optional().describe('Title colour: name or hex (default white)'),
    subtitleColor: z.string().optional().describe('Subtitle colour: name or hex (default #F2C14E, a warm gold)'),
    background: z.string().optional().describe('"transparent" (default, to lay over footage) or a colour name/hex for a solid background'),
    fontFile: z.string().optional().describe('Absolute path to a .ttf/.otf font. Default: Arial Bold on Windows.')
  })
};


export const VISION_TOOLS: MCPTool[] = [
  {
    name: 'list_clips',
    description: 'Lists the video clips in a folder with their durations. Use this first to see what footage exists before calling view_clip.',
    inputSchema: schemas.list_clips
  },
  {
    name: 'view_clip',
    description: 'SEE what is in a video file on disk. Returns a contact-sheet IMAGE of evenly spaced frames plus the exact timestamp of every frame, so you can describe the clip, judge quality (shake, focus, exposure) and pick the best sections. Works on any file, whether or not it is in the Premiere project; point it at proxies for speed. Use view_moment afterwards to pin down an exact moment.',
    inputSchema: schemas.view_clip
  },
  {
    name: 'view_moment',
    description: 'Close look at one section of a video file on disk (start/end in seconds): returns an IMAGE of frames across that range with exact timestamps. Use after view_clip to find the precise best moment or cut point, e.g. for a hook.',
    inputSchema: schemas.view_moment
  },
  {
    name: 'view_timeline',
    description: 'SEE the edit itself: exports frames from a range of a Premiere sequence and returns them as one IMAGE with sequence timestamps. Use it to review what you just built (the hook, a section, a title overlay) and fix problems before telling the user it is done. Requires the CEP bridge to be running.',
    inputSchema: schemas.view_timeline
  },
  {
    name: 'render_title_card',
    description: 'Renders an animated title (channel name and optional subtitle, sliding or fading in and out) to a .mov file with a transparent background (ProRes 4444), for intros and section titles. Returns a preview IMAGE so you can check it. Then import it with import_media and place it with add_to_timeline on a video track ABOVE the footage. Match width/height/fps to the sequence (get_sequence_settings).',
    inputSchema: schemas.render_title_card
  }
];

const VISION_NAMES = new Set(VISION_TOOLS.map((t) => t.name));

export function isVisionTool(name: string): boolean {
  return VISION_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// implementations
// ---------------------------------------------------------------------------

async function listClips(a: z.infer<typeof schemas.list_clips>): Promise<VisionToolResult> {
  const entries = await fs.readdir(a.folder, { withFileTypes: true }).catch(() => null);
  if (!entries) return { content: [text(`Folder not found: ${a.folder}`)], isError: true };
  const files = entries
    .filter((e) => e.isFile() && VIDEO_EXTS.has(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  if (files.length === 0) return { content: [text('No video files found in that folder.')] };
  const rows: string[] = [];
  let total = 0;
  for (const f of files) {
    try {
      const d = await probeDuration(join(a.folder, f));
      total += d;
      rows.push(`${f}\t${fmt(d)}`);
    } catch {
      rows.push(`${f}\t?`);
    }
  }
  rows.push(`\n${files.length} clips, ${fmt(total)} total`);
  return { content: [text(rows.join('\n'))] };
}

async function viewClip(a: z.infer<typeof schemas.view_clip>): Promise<VisionToolResult> {
  const dur = await probeDuration(a.path);
  const times = sampleTimes(0, dur, clampFrames(a.frames, 12));
  return withTempDir(async (dir) => {
    await grabFrames(a.path, times, a.width ?? 384, dir);
    const sheet = await tile(dir, times.length);
    return {
      content: [image(sheet), text(`${legend(basename(a.path), times)}\nClip length: ${fmt(dur)} (${dur.toFixed(2)}s)`)]
    };
  });
}

async function viewMoment(a: z.infer<typeof schemas.view_moment>): Promise<VisionToolResult> {
  const dur = await probeDuration(a.path);
  const start = Math.max(0, a.start);
  const end = Math.min(dur, a.end);
  if (end <= start) {
    return { content: [text(`end must be after start and within the clip (clip length ${dur.toFixed(2)}s).`)], isError: true };
  }
  const times = sampleTimes(start, end, clampFrames(a.frames, 8));
  return withTempDir(async (dir) => {
    await grabFrames(a.path, times, a.width ?? 480, dir);
    const sheet = await tile(dir, times.length);
    return { content: [image(sheet), text(legend(basename(a.path), times))] };
  });
}

async function viewTimeline(a: z.infer<typeof schemas.view_timeline>, runTool: ToolRunner): Promise<VisionToolResult> {
  if (a.end <= a.start) return { content: [text('end must be after start.')], isError: true };
  const times = sampleTimes(a.start, a.end, clampFrames(a.frames, 8));
  return withTempDir(async (dir) => {
    // Premiere exports one frame per call; do them in order (the bridge is serial).
    for (let i = 0; i < times.length; i++) {
      const t = times[i] as number;
      const want = join(dir, `raw${String(i).padStart(2, '0')}.png`).replace(/\\/g, '/');
      const res = await runTool('export_frame', { sequenceId: a.sequenceId, time: t, outputPath: want, format: 'png' });
      if (!res || res.success === false) {
        return { content: [text(`Premiere could not export the frame at ${fmt(t)}: ${res?.error ?? 'unknown error'}`)], isError: true };
      }
      const got: string = res.outputPath || want;
      await fs.copyFile(got, join(dir, `f${String(i).padStart(2, '0')}.png`));
    }
    const sheet = await tile(dir, times.length, 'png', a.width ?? 384);
    return { content: [image(sheet), text(legend('Sequence', times))] };
  });
}

async function renderTitleCard(a: z.infer<typeof schemas.render_title_card>): Promise<VisionToolResult> {
  if (!isAbsolute(a.outputPath)) return { content: [text('outputPath must be an absolute path.')], isError: true };
  const out = extname(a.outputPath).toLowerCase() === '.mov' ? a.outputPath : a.outputPath + '.mov';

  const W = a.width ?? 1920;
  const H = a.height ?? 1080;
  const FPS = a.fps ?? 25;
  const D = a.duration ?? 4;
  const anim = a.animation ?? 'slide_up';
  const pos = a.position ?? 'center';
  const transparent = !a.background || a.background.toLowerCase() === 'transparent';
  const bg = transparent ? 'black@0.0' : ffColor(a.background!);
  const font = a.fontFile ?? defaultFontFile();
  if (a.fontFile && !existsSync(a.fontFile)) return { content: [text(`Font file not found: ${a.fontFile}`)], isError: true };

  const s = H / 1080;
  const titleSize = Math.round((pos === 'center' ? 96 : 72) * s);
  const subSize = Math.round((pos === 'center' ? 46 : 40) * s);
  const shadow = Math.max(2, Math.round(3 * s));
  const FI = Math.min(0.7, D / 4); // fade/slide in
  const FO = Math.min(0.5, D / 5); // fade out
  const SUB_DELAY = 0.35;

  // alpha ramp: in over FI, hold, out over FO. `t0` delays the element.
  const alpha = (t0: number) =>
    `if(lt(t-${t0},0),0,if(lt(t-${t0},${FI}),(t-${t0})/${FI},if(lt(t,${D - FO}),1,max(0,(${D}-t)/${FO}))))`;
  // ease-out cubic progress 0->1 over FI
  const ease = (t0: number) => `(1-pow(1-min(max((t-${t0})/${FI},0),1),3))`;
  const travel = Math.round(70 * s);

  const gap = Math.round(titleSize * 0.35);
  let titleX: string, titleY: string, subX: string, subY: string;
  if (pos === 'center') {
    const block = a.subtitle ? titleSize + gap + subSize : titleSize;
    titleX = '(w-text_w)/2';
    subX = '(w-text_w)/2';
    titleY = `(h-${block})/2`;
    subY = `(h-${block})/2+${titleSize + gap}`;
  } else {
    titleX = `${Math.round(W * 0.06)}`;
    subX = titleX;
    titleY = `${Math.round(H * 0.70)}`;
    subY = `${Math.round(H * 0.70) + titleSize + gap}`;
  }
  const move = (x: string, y: string, t0: number): [string, string] => {
    if (anim === 'slide_up') return [x, `${y}+${travel}*(1-${ease(t0)})`];
    if (anim === 'slide_left') return [`${x}+${travel * 1.5}*(1-${ease(t0)})`, y];
    return [x, y];
  };

  return withTempDir(async (dir) => {
    // ffmpeg filter options need heavy escaping for paths like C:\Users\O'Brien\...
    // Avoid it entirely: copy the font and text next to each other in our temp
    // dir and run ffmpeg from there with plain relative names.
    await fs.writeFile(join(dir, 'title.txt'), a.title, 'utf8');
    let fontOpt = '';
    if (font) {
      const fontName = 'font' + (extname(font).toLowerCase() || '.ttf');
      await fs.copyFile(font, join(dir, fontName));
      fontOpt = `fontfile=${fontName}:`;
    }
    const common = `${fontOpt}expansion=none:shadowcolor=black@0.55:shadowx=${shadow}:shadowy=${shadow}`;

    const [tx, ty] = move(titleX, titleY, 0);
    const filters = [
      `drawtext=${common}:textfile=title.txt:fontsize=${titleSize}:fontcolor=${ffColor(a.textColor ?? 'white')}:x='${tx}':y='${ty}':alpha='${alpha(0)}'`
    ];
    if (a.subtitle) {
      await fs.writeFile(join(dir, 'sub.txt'), a.subtitle, 'utf8');
      const [sx, sy] = move(subX, subY, SUB_DELAY);
      filters.push(
        `drawtext=${common}:textfile=sub.txt:fontsize=${subSize}:fontcolor=${ffColor(a.subtitleColor ?? '#F2C14E')}:x='${sx}':y='${sy}':alpha='${alpha(SUB_DELAY)}'`
      );
    }

    const r = await run('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${bg}:s=${W}x${H}:r=${FPS}:d=${D},format=rgba`,
      '-vf', filters.join(','),
      '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0', '-an', out], dir);
    if (r.code !== 0 || !existsSync(out)) {
      return { content: [text(`ffmpeg could not render the title: ${r.stderr.slice(-600)}`)], isError: true };
    }

    // Preview: the moment both lines are fully in, over a dark grey backdrop.
    const previewT = Math.min(D - FO - 0.05, FI + SUB_DELAY + 0.3);
    const prev = join(dir, 'preview.jpg');
    const pr = await run('ffmpeg', ['-v', 'error', '-y', '-i', out,
      '-f', 'lavfi', '-i', `color=c=0x3c3c3c:s=${W}x${H}:r=${FPS}:d=${D}`,
      '-filter_complex', `[1:v][0:v]overlay=format=auto,trim=start=${previewT.toFixed(2)},setpts=PTS-STARTPTS,scale=960:-2`,
      '-frames:v', '1', '-q:v', '3', prev]);

    const info = [
      `Rendered ${out}`,
      `${W}x${H} @ ${FPS} fps, ${D}s, animation=${anim}, position=${pos}, background=${transparent ? 'transparent (ProRes 4444 with alpha)' : a.background}`,
      font ? `Font: ${font}` : 'Font: system default',
      'Next: import_media this file, then add_to_timeline on a video track above the footage at the time the title should appear.'
    ];
    const content: ToolContent[] = [];
    if (pr.code === 0 && existsSync(prev)) {
      content.push(image(await fs.readFile(prev)));
      info.push(`Preview above shows the title at ${previewT.toFixed(2)}s over grey (grey stands in for your footage).`);
    }
    content.push(text(info.join('\n')));
    return { content };
  });
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export async function executeVisionTool(name: string, args: Record<string, any>, runTool: ToolRunner): Promise<VisionToolResult> {
  const input = args ?? {};
  const bad = (err: z.ZodError): VisionToolResult =>
    ({ content: [text(`Invalid arguments for ${name}: ${err.message}`)], isError: true });
  try {
    await ensureFfmpeg();
    switch (name) {
      case 'list_clips': {
        const p = schemas.list_clips.safeParse(input);
        return p.success ? await listClips(p.data) : bad(p.error);
      }
      case 'view_clip': {
        const p = schemas.view_clip.safeParse(input);
        return p.success ? await viewClip(p.data) : bad(p.error);
      }
      case 'view_moment': {
        const p = schemas.view_moment.safeParse(input);
        return p.success ? await viewMoment(p.data) : bad(p.error);
      }
      case 'view_timeline': {
        const p = schemas.view_timeline.safeParse(input);
        return p.success ? await viewTimeline(p.data, runTool) : bad(p.error);
      }
      case 'render_title_card': {
        const p = schemas.render_title_card.safeParse(input);
        return p.success ? await renderTitleCard(p.data) : bad(p.error);
      }
      default:
        return { content: [text(`Unknown vision tool ${name}`)], isError: true };
    }
  } catch (e) {
    return { content: [text(e instanceof Error ? e.message : String(e))], isError: true };
  }
}
