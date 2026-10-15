/* MCP Transcript Bridge (UXP)
 *
 * This panel is deliberately a narrow companion to the CEP bridge. It reads
 * only the Premiere APIs that are unavailable to ExtendScript and communicates
 * with the MCP server through uxp/commands and uxp/responses below a
 * user-authorized bridge root.
 */
const { storage, host, versions, entrypoints } = require('uxp');
const { localFileSystem } = storage;
const ppro = require('premierepro');

const PROTOCOL_VERSION = 1;
const TICKS_PER_SECOND = 254016000000;
const POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 5000;
const ROOT_PATH_KEY = 'mcp_transcript_bridge_root_path';
const DEFAULT_BRIDGE_ROOT = '/tmp/premiere-mcp-bridge';

function secondsFromTime(value) {
  if (typeof value === 'number') return Math.abs(value) > 1000000 ? value / TICKS_PER_SECOND : value;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['seconds', 'second', 'timeInSeconds']) {
    if (typeof value[key] === 'number') return value[key];
  }
  for (const key of ['ticks', 'tickCount']) {
    if (value[key] !== undefined && value[key] !== null) {
      const ticks = Number(value[key]);
      if (Number.isFinite(ticks)) return ticks / TICKS_PER_SECOND;
    }
  }
  return null;
}

function transcriptTime(value) {
  if (typeof value === 'number') return Math.abs(value) > 1000000 ? value / TICKS_PER_SECOND : value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return transcriptTime(numeric);
    // A few transcript interchange variants use HH:MM:SS.mmm rather than a
    // numeric offset. Accept both colon and semicolon separators while keeping
    // the result in seconds.
    const match = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d+))?$/);
    if (match) {
      const hours = Number(match[1] || 0);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      const fraction = Number(`0.${match[4] || '0'}`);
      return hours * 3600 + minutes * 60 + seconds + fraction;
    }
  }
  if (value && typeof value === 'object') return secondsFromTime(value);
  return null;
}

function firstText(object) {
  for (const key of ['text', 'content', 'transcriptText', 'value']) {
    if (typeof object[key] === 'string' && object[key].trim()) return object[key].trim();
  }
  return null;
}

function firstTime(object, keys) {
  for (const key of keys) {
    const value = transcriptTime(object[key]);
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

function endFromOffsetAndDuration(object) {
  const start = firstTime(object, [
    'start', 'startTime', 'startSeconds', 'startTicks', 'start_time',
    'startTimeInSeconds', 'startTimeInTicks', 'offset', 'offsetSeconds',
    'offsetTicks', 'begin', 'beginTime', 'beginTimeSeconds'
  ]);
  const duration = firstTime(object, ['duration', 'durationSeconds', 'durationTicks', 'length', 'lengthSeconds', 'lengthTicks']);
  return start !== null && duration !== null && duration > 0 ? { start, end: start + duration } : null;
}

function textFromWords(object) {
  if (!Array.isArray(object.words)) return null;
  const words = object.words.map(firstText).filter(Boolean);
  return words.length ? words.join(' ') : null;
}

// Keep diagnostics useful without copying a user's transcript text into logs
// or files. This tells us the Adobe JSON's structural shape if a future build
// changes its field names.
function describeTranscriptShape(json) {
  const paths = new Set();
  const visit = (value, path, depth) => {
    if (!value || typeof value !== 'object' || depth > 5 || paths.size >= 40) return;
    if (Array.isArray(value)) {
      paths.add(`${path || '$'}[]`);
      value.slice(0, 2).forEach(entry => visit(entry, `${path || '$'}[]`, depth + 1));
      return;
    }
    const keys = Object.keys(value).sort();
    paths.add(`${path || '$'}{${keys.join(',')}}`);
    keys.slice(0, 20).forEach(key => visit(value[key], `${path || '$'}.${key}`, depth + 1));
  };
  visit(json, '', 0);
  return [...paths].join(' | ');
}

// Adobe returns a JSON TextSegments payload. The public API does not promise a
// stable, flattened wire shape, so accept the documented segment conventions
// and surface a per-clip warning if no usable timed segments can be found.
function extractTranscriptSegments(json) {
  const output = [];
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const text = firstText(value) || textFromWords(value);
    const start = firstTime(value, [
      'start', 'startTime', 'startSeconds', 'startTicks', 'start_time',
      'startTimeInSeconds', 'startTimeInTicks', 'begin', 'beginTime'
    ]);
    const end = firstTime(value, [
      'end', 'endTime', 'endSeconds', 'endTicks', 'end_time',
      'endTimeInSeconds', 'endTimeInTicks', 'finish', 'finishTime'
    ]);
    const hasCompleteSegment = text && start !== null && end !== null && end > start;
    if (hasCompleteSegment) output.push({ start, end, text });
    const offsetTiming = text && (start === null || end === null) ? endFromOffsetAndDuration(value) : null;
    if (text && offsetTiming) output.push({ ...offsetTiming, text });
    // Adobe's export schema is intentionally not specified. Walk every child
    // object so a nested TextSegments container is not missed simply because
    // its key changed between Premiere releases.
    Object.entries(value).forEach(([key, child]) => {
      // A parent segment with its own timing represents its words as one
      // coherent spoken phrase; don't emit that same phrase word-by-word.
      if ((hasCompleteSegment || offsetTiming) && key === 'words') return;
      if (child && typeof child === 'object') visit(child);
    });
  };
  visit(json);
  return output.filter((segment, index, all) => all.findIndex(other =>
    other.start === segment.start && other.end === segment.end && other.text === segment.text
  ) === index);
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(interval => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end + 0.001) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ start: interval.start, end: interval.end });
  }
  return merged;
}

function intervalDuration(intervals) {
  return intervals.reduce((total, interval) => total + (interval.end - interval.start), 0);
}

class TranscriptBridge {
  constructor() {
    this.rootFolder = null;
    this.commandFolder = null;
    this.responseFolder = null;
    this.statusFolder = null;
    this.running = false;
    this.processing = false;
    this.pollTimer = null;
    this.heartbeatTimer = null;
  }

  async init() {
    this.log('MCP Transcript Bridge loaded.');
    await this.restoreRootFolder();
    this.updateUi();
  }

  async restoreRootFolder() {
    const path = localStorage.getItem(ROOT_PATH_KEY) || DEFAULT_BRIDGE_ROOT;
    document.getElementById('bridgeRoot').value = path;
  }

  async configureRootPath(rawPath) {
    const path = String(rawPath || '').trim().replace(/\/+$/, '') || DEFAULT_BRIDGE_ROOT;
    try {
      // localFileSystem fullAccess is intentional: this CEP-style configuration
      // accepts a known absolute bridge path instead of forcing a folder picker.
      // macOS exposes /tmp as a symlink to /private/tmp. CEP follows that
      // symlink, but some UXP builds do not when resolving file: URLs.
      const filesystemPath = path === '/tmp' || path.startsWith('/tmp/')
        ? `/private${path}`
        : path;
      const url = filesystemPath.startsWith('file:') ? filesystemPath : `file:${filesystemPath}`;
      const folder = await localFileSystem.getEntryWithUrl(url);
      if (!folder.isFolder) throw new Error('Bridge root is not a folder.');
      await this.configureRoot(folder, path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot open bridge root ${path}. ${detail}`);
    }
  }

  async ensureFolder(parent, name) {
    try {
      const entry = await parent.getEntry(name);
      if (!entry.isFolder) throw new Error(`${name} exists but is not a folder`);
      return entry;
    } catch (_) {
      return parent.createFolder(name);
    }
  }

  async configureRoot(folder, path) {
    this.rootFolder = folder;
    const uxpFolder = await this.ensureFolder(folder, 'uxp');
    this.commandFolder = await this.ensureFolder(uxpFolder, 'commands');
    this.responseFolder = await this.ensureFolder(uxpFolder, 'responses');
    this.statusFolder = uxpFolder;
    localStorage.setItem(ROOT_PATH_KEY, path);
    document.getElementById('bridgeRoot').value = path;
    this.log(`Bridge root configured: ${folder.nativePath}`);
    this.updateUi();
  }

  async start() {
    const requestedPath = document.getElementById('bridgeRoot').value;
    if (!this.rootFolder || requestedPath !== localStorage.getItem(ROOT_PATH_KEY)) await this.configureRootPath(requestedPath);
    this.running = true;
    this.pollTimer = setInterval(() => this.poll().catch(error => this.log(String(error), 'error')), POLL_INTERVAL_MS);
    this.heartbeatTimer = setInterval(() => this.writeHeartbeat().catch(error => this.log(String(error), 'error')), HEARTBEAT_INTERVAL_MS);
    await this.writeHeartbeat();
    this.updateUi();
    this.log('Transcript bridge started.');
  }

  stop() {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.updateUi();
    this.log('Transcript bridge stopped.');
  }

  async poll() {
    if (!this.running || this.processing || !this.commandFolder) return;
    const entries = await this.commandFolder.getEntries();
    const commandFiles = entries
      .filter(entry => entry.isFile && /^command-[A-Za-z0-9-]+\.json$/.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!commandFiles.length) return;
    this.processing = true;
    try {
      await this.processCommandFile(commandFiles[0]);
    } finally {
      this.processing = false;
    }
  }

  async processCommandFile(file) {
    let command = null;
    try {
      command = JSON.parse(await file.read());
      if (!command || command.protocolVersion !== PROTOCOL_VERSION || !command.id || typeof command.operation !== 'string') {
        throw new Error('Invalid UXP command envelope.');
      }
      const result = await this.executeCommand(command);
      await this.writeResponse(command.id, { id: command.id, protocolVersion: PROTOCOL_VERSION, success: true, result });
      this.log(`Completed ${command.operation}.`);
    } catch (error) {
      const id = command && command.id ? command.id : file.name.replace(/^command-/, '').replace(/\.json$/, '');
      await this.writeResponse(id, {
        id,
        protocolVersion: PROTOCOL_VERSION,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      this.log(`Command failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      try { await file.delete(); } catch (_) { /* Node will clean stale commands too. */ }
    }
  }

  async writeResponse(id, payload) {
    const file = await this.responseFolder.createFile(`response-${id}.json`, { overwrite: true });
    await file.write(JSON.stringify(payload));
  }

  async executeCommand(command) {
    if (command.operation === 'read_sequence_transcription') {
      return this.readSequenceTranscription(command.args || {});
    }
    throw new Error(`Unsupported UXP operation: ${command.operation}`);
  }

  async findSequence(project, sequenceId) {
    if (!sequenceId) return project.getActiveSequence();
    try {
      const sequence = await project.getSequence(sequenceId);
      if (sequence) return sequence;
    } catch (_) { /* Check all sequences for older builds that reject a string GUID. */ }
    const sequences = await project.getSequences();
    return sequences.find(sequence => String(sequence.guid) === String(sequenceId)) || null;
  }

  async collectTrackItems(sequence, kind) {
    const count = kind === 'video' ? await sequence.getVideoTrackCount() : await sequence.getAudioTrackCount();
    const results = [];
    for (let index = 0; index < count; index++) {
      const track = kind === 'video' ? await sequence.getVideoTrack(index) : await sequence.getAudioTrack(index);
      const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      for (const item of items) results.push({ item, kind, trackIndex: index });
    }
    return results;
  }

  async classifyItem(candidate) {
    const { item, kind, trackIndex } = candidate;
    const projectItem = await item.getProjectItem();
    const sourceProjectItemId = await projectItem.getId();
    const sourceClipName = await item.getName();
    const start = secondsFromTime(await item.getStartTime());
    const end = secondsFromTime(await item.getEndTime());
    const sourceIn = secondsFromTime(await item.getInPoint());
    const sourceOut = secondsFromTime(await item.getOutPoint());
    const base = { sourceProjectItemId, sourceClipName, start, end, sourceIn, sourceOut, trackType: kind, trackIndex };
    if ([start, end, sourceIn, sourceOut].some(value => value === null)) return { unsupported: { ...base, reason: 'unreadable_timing' } };

    const clipProjectItem = ppro.ClipProjectItem.cast(projectItem);
    if (await clipProjectItem.isSequence()) return { unsupported: { ...base, reason: 'nested_sequence' } };
    if (await clipProjectItem.isMulticamClip()) return { unsupported: { ...base, reason: 'multicam_clip' } };
    const speed = await item.getSpeed();
    if (Number(speed) !== 1) return { unsupported: { ...base, reason: 'speed_changed' } };
    if (await item.isSpeedReversed()) return { unsupported: { ...base, reason: 'reversed_clip' } };
    return { regular: { ...base, clipProjectItem } };
  }

  async readSequenceTranscription(args) {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error('No active Premiere project.');
    const sequence = await this.findSequence(project, args.sequenceId);
    if (!sequence) throw new Error(args.sequenceId ? `Sequence not found: ${args.sequenceId}` : 'No active sequence.');

    const endTime = secondsFromTime(await sequence.getEndTime()) || 0;

    // Premiere's Text panel can hold a transcript on the sequence itself. A
    // sequence is represented by a ClipProjectItem in the project panel, and
    // Transcript.exportToJSON accepts that item. Prefer this authoritative
    // timeline transcript before trying source media (which is only a fallback
    // for projects that transcribed each clip independently).
    const sequenceTranscript = await this.readSequenceProjectItemTranscript(sequence);
    if (sequenceTranscript.segments.length) {
      const segments = sequenceTranscript.segments.map(segment => ({
        start: segment.start,
        end: segment.end,
        text: segment.text,
        sourceProjectItemId: sequenceTranscript.projectItemId,
        sourceClipName: sequence.name
      })).filter(segment => segment.end > segment.start && segment.start < endTime)
        .map(segment => ({ ...segment, start: Math.max(0, segment.start), end: Math.min(endTime, segment.end) }));
      const transcriptIntervals = segments.map(segment => ({ start: segment.start, end: segment.end }));
      return {
        success: true,
        partial: false,
        sequenceId: String(sequence.guid),
        sequenceName: sequence.name,
        durationSeconds: endTime,
        transcriptScope: 'sequence',
        segments,
        sourceTranscriptCoverageSeconds: intervalDuration(mergeIntervals(transcriptIntervals)),
        uncoveredIntervals: [],
        clipsWithoutTranscript: [],
        unsupportedClips: [],
        warnings: []
      };
    }

    const candidates = [
      ...(await this.collectTrackItems(sequence, 'video')),
      ...(await this.collectTrackItems(sequence, 'audio'))
    ];
    const unique = new Map();
    const unsupportedClips = [];
    for (const candidate of candidates) {
      const classified = await this.classifyItem(candidate);
      if (classified.unsupported) {
        unsupportedClips.push(classified.unsupported);
        continue;
      }
      const clip = classified.regular;
      const key = [clip.sourceProjectItemId, clip.start, clip.end, clip.sourceIn, clip.sourceOut].join('|');
      // Linked audio/video commonly point at the same source and same edit; do
      // not emit that transcript twice. Distinct overlapping source clips remain.
      if (!unique.has(key)) unique.set(key, clip);
    }

    const segments = [];
    const clipsWithoutTranscript = [];
    const warnings = [];
    const transcriptIntervals = [];
    for (const clip of unique.values()) {
      let raw;
      try {
        raw = await ppro.Transcript.exportToJSON(clip.clipProjectItem);
      } catch (error) {
        clipsWithoutTranscript.push({ ...this.publicClip(clip), reason: 'transcript_unavailable', error: String(error) });
        continue;
      }
      let transcriptJson;
      let sourceSegments;
      try {
        transcriptJson = JSON.parse(raw);
        sourceSegments = extractTranscriptSegments(transcriptJson);
      } catch (_) {
        clipsWithoutTranscript.push({ ...this.publicClip(clip), reason: 'malformed_transcript_json' });
        continue;
      }
      if (!sourceSegments.length) {
        const jsonShape = describeTranscriptShape(transcriptJson);
        clipsWithoutTranscript.push({ ...this.publicClip(clip), reason: 'no_timed_segments', jsonShape });
        warnings.push(`No timed transcript segments were available for ${clip.sourceClipName}. JSON shape: ${jsonShape}`);
        continue;
      }
      let contributed = false;
      for (const segment of sourceSegments) {
        const sourceStart = Math.max(segment.start, clip.sourceIn);
        const sourceEnd = Math.min(segment.end, clip.sourceOut);
        if (sourceEnd <= sourceStart) continue;
        const start = clip.start + (sourceStart - clip.sourceIn);
        const end = clip.start + (sourceEnd - clip.sourceIn);
        segments.push({ start, end, text: segment.text, sourceProjectItemId: clip.sourceProjectItemId, sourceClipName: clip.sourceClipName });
        transcriptIntervals.push({ start, end });
        contributed = true;
      }
      if (!contributed) clipsWithoutTranscript.push({ ...this.publicClip(clip), reason: 'no_segments_in_source_range' });
    }

    segments.sort((a, b) => a.start - b.start || a.end - b.end || a.text.localeCompare(b.text));
    const missingIntervals = [
      ...clipsWithoutTranscript.map(clip => ({ start: clip.start, end: clip.end, reason: clip.reason })),
      ...unsupportedClips.map(clip => ({ start: clip.start, end: clip.end, reason: clip.reason }))
    ];
    return {
      success: true,
      partial: missingIntervals.length > 0,
      sequenceId: String(sequence.guid),
      sequenceName: sequence.name,
      durationSeconds: endTime,
      transcriptScope: 'source_clips',
      segments,
      sourceTranscriptCoverageSeconds: intervalDuration(mergeIntervals(transcriptIntervals)),
      uncoveredIntervals: missingIntervals,
      clipsWithoutTranscript,
      unsupportedClips,
      warnings
    };
  }

  async readSequenceProjectItemTranscript(sequence) {
    let projectItemId = String(sequence.guid);
    try {
      const projectItem = await sequence.getProjectItem();
      projectItemId = await projectItem.getId();
      const sequenceClipProjectItem = ppro.ClipProjectItem.cast(projectItem);
      const raw = await ppro.Transcript.exportToJSON(sequenceClipProjectItem);
      const json = JSON.parse(raw);
      return { projectItemId, segments: extractTranscriptSegments(json) };
    } catch (error) {
      // Sequence transcripts are not available from all Premiere builds or
      // project states. The source-clip route below remains a useful fallback.
      this.log(`Sequence transcript export unavailable; checking source clips. ${String(error)}`, 'info');
      return { projectItemId, segments: [] };
    }
  }

  publicClip(clip) {
    const { clipProjectItem, ...publicClip } = clip;
    return publicClip;
  }

  async writeHeartbeat() {
    if (!this.statusFolder) return;
    const status = {
      protocolVersion: PROTOCOL_VERSION,
      running: this.running,
      bridge: 'MCP Transcript Bridge (UXP)',
      premiereVersion: host && host.version ? host.version : 'unknown',
      uxpVersion: versions && versions.uxp ? versions.uxp : 'unknown',
      timestamp: new Date().toISOString()
    };
    const file = await this.statusFolder.createFile('status.json', { overwrite: true });
    await file.write(JSON.stringify(status));
    document.getElementById('hostInfo').textContent = `Premiere ${status.premiereVersion} · UXP ${status.uxpVersion}`;
  }

  updateUi() {
    document.getElementById('status').textContent = this.running ? 'Running' : 'Stopped';
    document.getElementById('status').className = this.running ? 'ok' : 'muted';
    document.getElementById('start').disabled = this.running;
    document.getElementById('stop').disabled = !this.running;
  }

  log(message, level = 'info') {
    const line = document.createElement('div');
    line.className = level;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    const log = document.getElementById('log');
    log.appendChild(line);
    while (log.children.length > 60) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
    console.log(`[MCP Transcript Bridge] ${message}`);
  }
}

let bridge;
entrypoints.setup({
  panels: {
    'mcp-uxp-bridge-panel': {
      show() {},
      hide() {}
    }
  }
});
window.addEventListener('DOMContentLoaded', async () => {
  bridge = new TranscriptBridge();
  await bridge.init();
  document.getElementById('save').addEventListener('click', () => bridge.configureRootPath(document.getElementById('bridgeRoot').value).catch(error => bridge.log(String(error), 'error')));
  document.getElementById('start').addEventListener('click', () => bridge.start().catch(error => bridge.log(String(error), 'error')));
  document.getElementById('stop').addEventListener('click', () => bridge.stop());
});
