import fs from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.argv[2] || '.');
const files = await fs.readdir(directory);

function topEntries(map, limit = 25) {
  return [...map.entries()].map(([name, value]) => ({ name, ...value }))
    .sort((left, right) => right.totalMs - left.totalMs).slice(0, limit);
}

async function analyzeTrace(file) {
  const payload = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
  const events = payload.traceEvents ?? [];
  const threadNames = new Map();
  for (const event of events) {
    if (event.ph === 'M' && event.name === 'thread_name') threadNames.set(`${event.pid}:${event.tid}`, event.args?.name ?? '');
  }
  const rendererThreadKeys = [...threadNames.entries()]
    .filter(([, name]) => /CrRendererMain|RendererMain/i.test(name)).map(([key]) => key);
  const selectedThreadKeys = new Set(rendererThreadKeys.length ? rendererThreadKeys : [...threadNames.keys()]);
  const complete = events.filter((event) => event.ph === 'X' && selectedThreadKeys.has(`${event.pid}:${event.tid}`));
  const eventTotals = new Map();
  const eventDispatch = new Map();
  const longTasks = [];
  let gcMs = 0;
  for (const event of complete) {
    const durationMs = Number(event.dur || 0) / 1000;
    const current = eventTotals.get(event.name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1; current.totalMs += durationMs; current.maxMs = Math.max(current.maxMs, durationMs);
    eventTotals.set(event.name, current);
    if (/GC|GarbageCollect/i.test(event.name)) gcMs += durationMs;
    if (/RunTask|TaskQueueManager::ProcessTaskFromWorkQueue/i.test(event.name) && durationMs >= 50) {
      longTasks.push({ name: event.name, durationMs, timestampMs: Number(event.ts || 0) / 1000 });
    }
    if (event.name === 'EventDispatch') {
      const type = event.args?.data?.type ?? 'unknown';
      const item = eventDispatch.get(type) ?? { count: 0, totalMs: 0, maxMs: 0 };
      item.count += 1; item.totalMs += durationMs; item.maxMs = Math.max(item.maxMs, durationMs);
      eventDispatch.set(type, item);
    }
  }
  const timestamps = complete.map((event) => Number(event.ts || 0));
  const ends = complete.map((event) => Number(event.ts || 0) + Number(event.dur || 0));
  return {
    file,
    bytes: (await fs.stat(path.join(directory, file))).size,
    rendererThreads: rendererThreadKeys.map((key) => ({ key, name: threadNames.get(key) })),
    durationMs: timestamps.length ? (Math.max(...ends) - Math.min(...timestamps)) / 1000 : 0,
    completeEvents: complete.length,
    gcMs,
    longTasks: longTasks.sort((left, right) => right.durationMs - left.durationMs),
    eventDispatch: topEntries(eventDispatch, 20),
    topEvents: topEntries(eventTotals),
  };
}

async function analyzeHeap(file) {
  const payload = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
  const meta = payload.snapshot.meta;
  const fields = meta.node_fields;
  const width = fields.length;
  const typeIndex = fields.indexOf('type');
  const nameIndex = fields.indexOf('name');
  const sizeIndex = fields.indexOf('self_size');
  const typeNames = meta.node_types[typeIndex];
  const byType = new Map();
  const byName = new Map();
  let totalSelfBytes = 0;
  let nodeCount = 0;
  for (let offset = 0; offset < payload.nodes.length; offset += width) {
    const type = typeNames[payload.nodes[offset + typeIndex]] ?? 'unknown';
    const name = payload.strings[payload.nodes[offset + nameIndex]] ?? '';
    const size = Number(payload.nodes[offset + sizeIndex] || 0);
    totalSelfBytes += size; nodeCount += 1;
    const typeValue = byType.get(type) ?? { count: 0, totalMs: 0, maxMs: 0 };
    typeValue.count += 1; typeValue.totalMs += size; typeValue.maxMs = Math.max(typeValue.maxMs, size); byType.set(type, typeValue);
    if (size > 0) {
      const nameValue = byName.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
      nameValue.count += 1; nameValue.totalMs += size; nameValue.maxMs = Math.max(nameValue.maxMs, size); byName.set(name, nameValue);
    }
  }
  const convert = (entries) => entries.map((entry) => ({
    name: entry.name, count: entry.count, selfBytes: entry.totalMs, maxSelfBytes: entry.maxMs,
  }));
  return {
    file, nodeCount, totalSelfBytes,
    byType: convert(topEntries(byType, 20)),
    topNames: convert(topEntries(byName, 30)),
  };
}

const traces = [];
for (const file of files.filter((name) => name.endsWith('.trace.json')).sort()) traces.push(await analyzeTrace(file));
const heaps = [];
for (const file of files.filter((name) => name.endsWith('.heapsnapshot')).sort()) heaps.push(await analyzeHeap(file));
const output = { directory, traces, heaps };
await fs.writeFile(path.join(directory, 'artifact-analysis.json'), JSON.stringify(output, null, 2), 'utf8');
console.log(JSON.stringify({
  output: path.join(directory, 'artifact-analysis.json'),
  traces: traces.map(({ file, durationMs, gcMs, longTasks, eventDispatch }) => ({ file, durationMs, gcMs, longTasks: longTasks.slice(0, 3), eventDispatch })),
  heaps: heaps.map(({ file, nodeCount, totalSelfBytes, topNames }) => ({ file, nodeCount, totalSelfBytes, topNames: topNames.slice(0, 8) })),
}, null, 2));
