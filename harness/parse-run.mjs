#!/usr/bin/env node
// Shared parsing for VIctory run logs. summarize-run.mjs and experiment-table.mjs both use it.
import fs from 'node:fs';

export const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s) => s.replace(ANSI_RE, '');

const num = Number;
export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Nearest-rank percentile: the smallest sample with at least `p` of the
// samples at or below it. The same rule presentmon.mjs uses for its p95.
export const percentile = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(p * s.length) - 1);
  return s[Math.min(rank, s.length - 1)];
};

export const FRAME_RE =
  /^(\S+Z)\s+\w+\s+\S+:\s+([\d.]+) fps, ([\d.]+) ms\/frame \((.*?)\), (\d+) draws\/frame, dropped (\d+) without a host pipeline \((\d+) being made\) and (\d+) indirect/;
export const COST_RE =
  /([\d.]+) preparing: copies ([\d.]+) ms ([\d.]+) MB, textures ([\d.]+) ms ([\d.]+) MB; ([\d.]+) on the GPU; ([\d.]+) copying back ([\d.]+) MB/;
const PRESENT_RE = /frame presented .*frame=(\d+) draws=(\d+) drawn=(\d+) dispatches=(\d+) dispatched=(\d+)/;
// Both "host pipeline refused" (graphics/compute) and "host mesh pipeline refused".
const REFUSED_RE = /host (?:mesh )?pipeline refused .*shaders=\[(.*?)\]/;
const SLOW_RE = /slow host submission ms=(\d+) lists=(\d+) pipelines=\{(.*)\}/;
const SLOW_LIST_RE = /slow host list ms=(\d+) commands=(\d+)/;
const SLOW_CMD_RE = /slow list command, ([\d.]+) ms: (.*)/;
const MISSING_RE =
  /no host texture .*desc=ResourceDesc \{ .*width: (\d+), height: (\d+), depth_or_array_size: \d+, mip_levels: \d+, format: (\d+), sample_count: (\d+)/;
const TRANSLATED_RE = /shader translated stage="(\w+)" hash=([0-9a-f]+)/;
const FAILURE_RE = /device removed|GPU failure|panic|assertion failed/;
const HANG_RE =
  /a list stopped at command (\d+) of (\d+) \(op (\d+)\)[^;]*; command \d+ \(op \d+\): (.*?)(?: \| |$)/;
const DRIVER_EVENT_RE = /^driver event:\s+(\S+)\s+id=(\d+)\s+(.*)$/;
const TITLE_CRASH_RE = /unhandled exception/i;
const NO_MARKER_RE = /\bno marker\b/i;

// The harness appends one "driver event:" line per Windows driver event (driver-events.ps1).
// Fill the counts the summary and the experiment table need, and drop the ESR register addresses:
// they differ per shader core, while the values are what repeats across a fault.
export function summarizeDriverEvents(events) {
  const counts = { mmuFault: 0, multipleWarpErrors: 0, otherId13: 0, id153: 0 };
  const esrSets = new Map();
  for (const event of events) {
    if (event.id === 153) {
      counts.id153 += 1;
    } else if (event.id === 13) {
      if (/MMU Fault/i.test(event.text)) counts.mmuFault += 1;
      else if (/Multiple Warp Errors/i.test(event.text)) counts.multipleWarpErrors += 1;
      else counts.otherId13 += 1;
      const values = [...event.text.matchAll(/0x[0-9a-fA-F]+=(0x[0-9a-fA-F]+)/g)].map((m) => m[1]);
      if (values.length) {
        const key = values.join(' ');
        esrSets.set(key, (esrSets.get(key) || 0) + 1);
      }
    }
  }
  const esrValueSets = [...esrSets.entries()]
    .map(([key, count]) => ({ values: key.split(' '), count }))
    .sort((a, b) => b.count - a.count || (a.values.join(' ') < b.values.join(' ') ? -1 : 1));
  return { total: events.length, counts, esrValueSets };
}

// The rule clean-failures.mjs has always used.
const SHADER_FAILURE_RE = /stage="?(\w+)"? hash=([0-9a-f]+) error=(.*)$/;
// Each prefix is optional: older logs carry both, newer logs only the GFX10 one.
const SHADER_FAILURE_PREFIX_RE =
  /^(?:converter shader\.dxil v1: )?(?:GFX10 code at 0x[0-9a-f]+: )?/;
// Newer logs append diagnostics such as "cached=false ms=9 user_ms=0 kernel_ms=0".
// Strip only a trailing run of space-separated key=value tokens, never an "=" mid-reason.
const SHADER_FAILURE_TRAILER_RE = /(?:\s+\w+=\S+)+\s*$/;

const ts = (s) => {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

export function readLogLines(path) {
  return fs
    .readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => stripAnsi(line));
}

export function parseTranslationFailures(lines) {
  if (typeof lines === 'string') lines = lines.replace(ANSI_RE, '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const m = line.match(SHADER_FAILURE_RE);
    if (!m) continue;
    out.push({
      stage: m[1],
      hash: m[2],
      reason: m[3]
        .replace(SHADER_FAILURE_PREFIX_RE, '')
        .replace(SHADER_FAILURE_TRAILER_RE, ''),
    });
  }
  return out;
}

export function parseLogLines(lines, path) {
  const frames = []; // frame-rate lines
  const presented = [];
  const refused = [];
  const slow = [];
  const slowLists = [];
  const slowCmds = [];
  const missing = [];
  const translated = { total: 0, byStage: {} };
  const failures = [];
  const hangs = [];
  const driverEvents = [];
  let firstTs = null;
  let lastTs = null;

  for (const line of lines) {
    if (!line) continue;
    const m = line.match(/^(\S+Z)\s/);
    if (m) {
      const t = ts(m[1]);
      if (t !== null) {
        if (firstTs === null) firstTs = t;
        lastTs = t;
      }
    }
    let r;
    if ((r = line.match(FRAME_RE))) {
      const costs = line.match(COST_RE);
      frames.push({
        ts: r[1],
        fps: num(r[2]),
        ms: num(r[3]),
        draws: num(r[5]),
        dropped: num(r[6]),
        making: num(r[7]),
        indirect: num(r[8]),
        preparing: costs ? num(costs[1]) : null,
        copiesMs: costs ? num(costs[2]) : null,
        copiesMb: costs ? num(costs[3]) : null,
        texturesMs: costs ? num(costs[4]) : null,
        texturesMb: costs ? num(costs[5]) : null,
        gpuMs: costs ? num(costs[6]) : null,
        backMs: costs ? num(costs[7]) : null,
        backMb: costs ? num(costs[8]) : null,
      });
    } else if ((r = line.match(PRESENT_RE))) {
      presented.push({ frame: num(r[1]), draws: num(r[2]), dispatches: num(r[4]) });
    } else if ((r = line.match(REFUSED_RE))) {
      refused.push(r[1]);
    } else if ((r = line.match(SLOW_RE))) {
      const entries = (r[3].match(/\[[^\]]*\]/g) || []).length;
      slow.push({ ms: num(r[1]), lists: num(r[2]), entries });
    } else if ((r = line.match(SLOW_LIST_RE))) {
      slowLists.push({ ms: num(r[1]), commands: num(r[2]) });
    } else if ((r = line.match(SLOW_CMD_RE))) {
      slowCmds.push({ ms: num(r[1]), desc: r[2] });
    } else if ((r = line.match(MISSING_RE))) {
      missing.push({ w: num(r[1]), h: num(r[2]), format: num(r[3]), samples: num(r[4]) });
    } else if ((r = line.match(TRANSLATED_RE))) {
      translated.total += 1;
      translated.byStage[r[1]] = (translated.byStage[r[1]] || 0) + 1;
    } else if ((r = line.match(DRIVER_EVENT_RE))) {
      driverEvents.push({ ts: r[1], id: num(r[2]), text: r[3].trim() });
    }
    if ((r = line.match(HANG_RE))) {
      const noMarker = NO_MARKER_RE.test(r[4]);
      hangs.push({
        at: num(r[1]),
        of: num(r[2]),
        op: num(r[3]),
        command: noMarker ? 'no marker' : r[4].slice(0, 200),
        pipelineUnknown: noMarker ? 'no marker' : null,
      });
    }
    const titleEnded = line.match(TITLE_ENDED_RE);
    const failed =
      FAILURE_RE.test(line) ||
      TITLE_CRASH_RE.test(line) ||
      (titleEnded && num(titleEnded[2]) !== 0);
    if (failed && failures.length < 5) failures.push(line.trim().slice(0, 300));
  }

  const fps = frames.map((f) => f.fps);
  const worst = [...frames].sort((a, b) => a.fps - b.fps).slice(0, 5);
  const last = frames.at(-1) || null;
  const missingBy = {};
  for (const m of missing) {
    const k = `format ${m.format} ${m.w}x${m.h} x${m.samples}`;
    missingBy[k] = (missingBy[k] || 0) + 1;
  }
  const duration =
    firstTs !== null && lastTs !== null ? Math.round((lastTs - firstTs) / 1000) : null;

  const summary = {
    file: path,
    durationSeconds: duration,
    lastFrame: presented.at(-1) || null,
    fps: {
      samples: fps.length,
      median: median(fps),
      min: fps.length ? Math.min(...fps) : null,
      max: fps.length ? Math.max(...fps) : null,
      last: last ? last.fps : null,
    },
    costs: last
      ? {
          preparingMs: last.preparing,
          copiesMs: last.copiesMs,
          copiesMb: last.copiesMb,
          texturesMs: last.texturesMs,
          texturesMb: last.texturesMb,
          gpuMs: last.gpuMs,
          readbackMs: last.backMs,
          readbackMb: last.backMb,
        }
      : null,
    lastFrameLine: last,
    worstFrames: worst,
    refusedPipelines: { count: refused.length, hashes: refused.slice(0, 20) },
    slowSubmissions: slow,
    missingTextures: missingBy,
    translated,
    driverEvents: summarizeDriverEvents(driverEvents),
    failures,
  };

  return { summary, details: { slowLists, slowCmds, hangs }, firstTs, lastTs };
}

export function parseRun(path) {
  return parseLogLines(readLogLines(path), path).summary;
}

export function parseRunDetails(path) {
  return parseLogLines(readLogLines(path), path);
}

// heavy-watch.mjs appends this after it ends the game, before the summary is made.
// A run that carries it was ended on purpose, whatever its last lines say.
export const HARNESS_ENDED_RE =
  /^harness: ended by --(?:heavy|settled)-seconds after ([\d.]+) s of (heavy|settled) scene\s*$/;
/// The settle marker run-world.sh's settled watcher appends, and the cap that ends an unsettled run.
export const HARNESS_SETTLED_RE = /^harness: settled at (\d+) s \(waiting (\d+), ([\d.]+) fps\)\s*$/;
export const HARNESS_SETTLE_TIMEOUT_RE =
  /^harness: ended by --settled-timeout after ([\d.]+) s: the scene never settled\s*$/;

// The runtime's own lines for how it ended: kernel.rs logs a title-chosen exit, main.rs logs the runtime's
// normal end. run-world.sh appends the game process's own exit code before the summary.
export const TITLE_ENDED_RE = /title ended the process: call ([^,]+), code (\d+), from /;
export const HARNESS_VICTORY_EXIT_RE = /^harness: victory exit=(\d+)\s*$/;
const RUNTIME_EXIT_0_RE = /runtime exit: code 0\b/;

const DEVICE_REMOVED_RE = /^(?:\S+Z\s+\w+\s+\S+:\s+|VIctory:\s*).*?\bdevice removed\b/i;
const CLEAN_EXIT_RE =
  /^(?:(?:\S+Z\s+\w+\s+\S+:\s+|VIctory:\s*).*?(?:exited cleanly|exit(?:ed)?\s+(?:code|status)\s*0\b|clean exit|run complete)|title exited with\s+(?:0|0x0)\b)/i;

function lineTimestamp(line) {
  const m = line.match(/^(\S+Z)\s/);
  return m ? ts(m[1]) : null;
}

function parseHung(lines, index) {
  const line = lines[index];
  const stop = line.match(/a list stopped at command (\d+) of (\d+) \(op (\d+)\)/);
  if (!stop) return null;
  const command = num(stop[1]);
  const total = num(stop[2]);
  const op = num(stop[3]);

  let list = null;
  const breadcrumbs = line.match(/breadcrumbs \(done\/count, list\) \[([^\]]*)\]/);
  if (breadcrumbs) {
    const entries = [...breadcrumbs[1].matchAll(/"(\d+)\/(\d+) (?:None|Some\((\d+)\))"/g)].map(
      (m) => ({ done: num(m[1]), count: num(m[2]), list: m[3] === undefined ? null : num(m[3]) }),
    );
    const hit = entries.find((e) => e.done === command && e.count === total && e.list !== null);
    if (hit) list = hit.list;
  }

  let pipelineHash = null;
  let stage = null;
  let pipelineUnknown = null;
  const nullSlots = [];
  const segmentRe =
    /;\s*command\s+(\d+)\s+\(op\s+\d+\)\s*:\s*(.*?)(?=;\s*command\s+\d+\s+\(op\s+\d+\)\s*:|$)/g;
  const segment = [...line.matchAll(segmentRe)].find((m) => num(m[1]) === command);
  if (segment) {
    const desc = segment[2];
    const pipe = desc.indexOf(' | ');
    const head = pipe >= 0 ? desc.slice(0, pipe) : desc;
    if (NO_MARKER_RE.test(head)) {
      // With no marker the rest of the line is other lists' dumps; a hash in them is not the stopped command's.
      pipelineUnknown = 'no marker';
    } else {
      const pipelines = [...head.matchAll(/\b(mesh|pixel|vertex|compute)\s+([0-9a-f]{4,})\b/g)];
      if (pipelines.length) {
        stage = pipelines[0][1];
        pipelineHash = pipelines[0][2];
        const hashes = new Set(pipelines.map((m) => m[2]));
        // The DRED dump of the stopped command is pretty-printed over the following
        // lines; only its own pipeline hashes count, never a later list's dump.
        let end = index + 1;
        while (end < lines.length && !/^(?:\S+Z\s|VIctory:)/.test(lines[end])) end += 1;
        const slots = new Set();
        for (let i = index; i < end; i += 1) {
          for (const dump of lines[i].matchAll(/\|\s*([0-9a-f]{4,}):(.*)$/g)) {
            if (!hashes.has(dump[1])) continue;
            for (const slot of dump[2].matchAll(/\bu(\d+)=[^\s]+ \[heap \d+: null\]/g))
              slots.add(num(slot[1]));
          }
        }
        nullSlots.push(...[...slots].sort((a, b) => a - b).map((n) => `u${n}`));
      }
    }
  }

  return { list, command, total, op, pipelineHash, stage, pipelineUnknown, nullSlots };
}

function parseDred(lines) {
  let lastCompletedOp = null;
  let hungOp = null;
  for (const line of lines) {
    if (!/\bDRED\b/i.test(line)) continue;
    let m = line.match(/last completed(?: command)? op\s*[=:]?\s*(\d+)/i);
    if (m) lastCompletedOp = num(m[1]);
    m = line.match(/hung(?: command| on)? op\s*[=:]?\s*(\d+)/i);
    if (m) hungOp = num(m[1]);
  }
  if (lastCompletedOp === null) {
    for (const line of lines) {
      const m = line.match(/last completed(?: command)? op\s*[=:]?\s*(\d+)/i);
      if (m) {
        lastCompletedOp = num(m[1]);
        break;
      }
    }
  }
  if (hungOp === null) {
    for (const line of lines) {
      const m = line.match(/hung(?: command| on)? op\s*[=:]?\s*(\d+)/i);
      if (m) {
        hungOp = num(m[1]);
        break;
      }
    }
  }
  return { lastCompletedOp, hungOp };
}

// run-world.sh writes one "harness env: NAME=value" line per VICTORY_* variable.
// Settings come only from those lines: the runtime also echoes them, and its failure text
// says "a diagnostics build with VICTORY_D3D12_DEBUG=1 names the command", which is not a
// record of what the run set.
const HEADER_ENV_RE = /^harness env:\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const HEADER_LINE_RE = /^harness (?:build|env):/;
const FALSEY_RE = /^(?:0|false|off|disabled|no|none)$/i;

function parseSettings(lines) {
  const env = new Map();
  let hasHeader = false;
  for (const line of lines) {
    if (HEADER_LINE_RE.test(line)) hasHeader = true;
    const m = line.match(HEADER_ENV_RE);
    if (m && !env.has(m[1])) env.set(m[1], m[2].trim());
  }

  const value = (name) => (env.has(name) ? env.get(name) : null);
  // Named in the header: on. A header without it: the run did not set it, so off.
  // No header at all: the log cannot say, so unknown.
  const flag = (name) => {
    const raw = value(name);
    if (raw === null) return hasHeader ? false : null;
    return raw !== '' && !FALSEY_RE.test(raw);
  };

  const settings = {
    skippedPipelines: null,
    loopLimit: null,
    wave64: null,
    gpuTiming: flag('VICTORY_GPU_TIMING'),
    d3d12Debug: flag('VICTORY_D3D12_DEBUG'),
    d3d12Gbv: flag('VICTORY_D3D12_GBV'),
    copyMode: null,
    aftermath: flag('VICTORY_AFTERMATH'),
    record: flag('record'),
  };

  const skip = value('VICTORY_SKIP_PIPELINES');
  if (skip !== null) {
    let list = skip.replace(/[,\s;]+$/, '').replace(/^["']|["']$/g, '');
    if (!list || /^(?:none|\[\]|-)$/i.test(list)) list = 'none';
    settings.skippedPipelines = list;
  }
  const loop = value('VICTORY_SHADER_LOOP_LIMIT');
  if (loop !== null && /^\d+$/.test(loop)) settings.loopLimit = num(loop);
  const wave = value('VICTORY_WAVE64_EMULATE');
  if (wave) settings.wave64 = wave;
  const copy = value('VICTORY_COPY_MODE');
  if (copy) settings.copyMode = copy;
  return settings;
}

export function parseExtras(lines, firstTs, lastTs) {
  const removalIndex = lines.findIndex((line) => DEVICE_REMOVED_RE.test(line));
  let removalTs = null;
  let removalSeconds = null;
  let removalFrame = null;

  if (removalIndex >= 0) {
    removalTs = lineTimestamp(lines[removalIndex]);
    if (removalTs === null) removalTs = lastTs;
    if (firstTs !== null && removalTs !== null)
      removalSeconds = Math.round((removalTs - firstTs) / 1000);
    for (let i = 0; i <= removalIndex; i += 1) {
      const m = lines[i].match(PRESENT_RE);
      if (m) removalFrame = num(m[1]);
    }
  }

  let ending;
  const harnessEnded = lines.map((line) => line.match(HARNESS_ENDED_RE)).find(Boolean);
  const titleEnded = lines.map((line) => line.match(TITLE_ENDED_RE)).find(Boolean);
  const victoryExit = lines.map((line) => line.match(HARNESS_VICTORY_EXIT_RE)).find(Boolean);
  const exitCode = victoryExit ? num(victoryExit[1]) : null;
  if (harnessEnded) {
    const seconds = num(harnessEnded[1]);
    ending = {
      kind: 'harness_ended',
      seconds,
      frame: null,
      text: `ended by the harness after ${harnessEnded[1]} s of ${harnessEnded[2]} scene`,
    };
  } else if (removalIndex >= 0) {
    const text = `device removed @ ${removalSeconds === null ? '?' : removalSeconds} s, after logged frame ${removalFrame === null ? '—' : removalFrame}`;
    ending = { kind: 'device_removed', seconds: removalSeconds, frame: removalFrame, text };
  } else if (lines.some((line) => TITLE_CRASH_RE.test(line))) {
    ending = { kind: 'title_crashed', seconds: null, frame: null, text: 'title crashed' };
  } else if (titleEnded) {
    ending = {
      kind: 'title_ended',
      seconds: null,
      frame: null,
      text: `the title ended the process: ${titleEnded[1]}, code ${num(titleEnded[2])}`,
    };
  } else if (exitCode !== null && exitCode !== 0) {
    // The process ended with a code and the log names no cause: today this read as "log ends", which hid a
    // run something else stopped (a gotcha was found this way).
    ending = {
      kind: 'exited_without_a_failure_line',
      seconds: null,
      frame: null,
      text: `exited with code ${victoryExit[1]} and no failure line: check what else was running`,
    };
  } else if (
    lines.some((line) => CLEAN_EXIT_RE.test(line) || RUNTIME_EXIT_0_RE.test(line)) ||
    exitCode === 0
  ) {
    ending = { kind: 'clean_exit', seconds: null, frame: null, text: 'clean exit' };
  } else {
    ending = { kind: 'log_ends', seconds: null, frame: null, text: 'log ends' };
  }

  const hung = removalIndex >= 0 ? parseHung(lines, removalIndex) : null;
  const explicitDred = parseDred(lines);
  const dred =
    explicitDred.lastCompletedOp !== null || explicitDred.hungOp !== null || hung !== null
      ? { lastCompletedOp: explicitDred.lastCompletedOp, hungOp: explicitDred.hungOp ?? hung?.op ?? null }
      : null;

  const settledLine = lines.map((line) => line.match(HARNESS_SETTLED_RE)).find(Boolean);
  const settled = settledLine
    ? { seconds: num(settledLine[1]), waiting: num(settledLine[2]), fps: num(settledLine[3]) }
    : null;
  const settledTimeout = lines.some((line) => HARNESS_SETTLE_TIMEOUT_RE.test(line));
  return { ending, hung, dred, settings: parseSettings(lines), settled, settledTimeout };
}

export function parseRunFile(path) {
  const lines = readLogLines(path);
  const { summary, firstTs, lastTs } = parseLogLines(lines, path);
  return {
    summary,
    extras: parseExtras(lines, firstTs, lastTs, summary),
    translationFailures: parseTranslationFailures(lines),
    lines, // summarize-run.mjs and experiment-table.mjs read the capture folder from these
  };
}
