#!/usr/bin/env node
// mcp-bench.mjs: connect to any MCP server (stdio command or remote URL), list its tools and
// run identical tasks against it N times. Writes one JSON per server with latency, success rate,
// payload size and the raw responses, so the "Best {Target} MCP" articles are measured, not guessed.
//
// Fixture file (fixtures/{slug}.json):
// {
//   "target": "zillow",
//   "servers": [
//     { "id": "hasdata", "transport": "http", "url": "https://mcp.hasdata.com/api/mcp?apis=zillow", "headers": { "x-api-key": "$HASDATA_API_KEY" },
//       "tasks": [ { "name": "search", "tool": "hasdata_zillow_listing_getRealEstateListings", "args": { "keyword": "Austin, TX", "type": "forSale" } } ] },
//     { "id": "chrischall", "transport": "stdio", "command": "npx", "args": ["-y", "zillow-mcp"], "env": {},
//       "tasks": [ { "name": "search", "tool": "search_listings", "args": { "location": "Austin, TX" } } ] }
//   ]
// }
// "$VAR" in headers/env is read from process.env (.env is loaded from the repo root).
//
// Usage:
//   node mcp-bench.mjs probe zillow            # connect + list tools for every server, write tools/*.json
//   node mcp-bench.mjs run zillow [--runs 5] [--only id1,id2]   # execute tasks, write results/*.json
//   node mcp-bench.mjs report zillow           # markdown summary table from results/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BENCH = process.env.MCP_BENCH_DIR ? path.resolve(process.env.MCP_BENCH_DIR) : ROOT;

// ---------- env ----------
for (const line of fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/) : []) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const expandStr = (v) => typeof v === 'string' ? v.replace(/\$([A-Z0-9_]+)/g, (_, n) => process.env[n] ?? '') : v;
const expand = (obj = {}) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, expandStr(v)]));

// ---------- cli ----------
const [, , cmd, slug, ...rest] = process.argv;
if (!cmd || !slug) {
    console.error('usage: mcp-bench.mjs probe|run|report <target-slug> [--runs N] [--only a,b] [--timeout ms]');
    process.exit(1);
}
const flag = (name, def) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : def;
};
const RUNS = Number(flag('runs', 5));
const ONLY = flag('only', '') ? flag('only', '').split(',') : null;
const TIMEOUT = Number(flag('timeout', 90_000));

const fixturePath = path.join(BENCH, 'fixtures', `${slug}.json`);
if (!fs.existsSync(fixturePath)) {
    console.error(`no fixture at ${fixturePath}`);
    process.exit(1);
}
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const servers = fixture.servers.filter((s) => !ONLY || ONLY.includes(s.id));
const outDir = (kind) => {
    const d = path.join(BENCH, kind, slug);
    fs.mkdirSync(d, { recursive: true });
    return d;
};

// ---------- connect ----------
async function connect(server) {
    const t0 = performance.now();
    let transport;
    if (server.transport === 'stdio') {
        transport = new StdioClientTransport({
            command: process.platform === 'win32' && server.command === 'npx' ? 'npx.cmd' : server.command,
            args: server.args || [],
            env: { ...process.env, ...expand(server.env) },
            stderr: 'pipe',
        });
        transport.stderr?.on('data', (d) => { server._stderr = ((server._stderr || '') + d.toString()).slice(-4000); });
    } else if (server.transport === 'http') {
        transport = new StreamableHTTPClientTransport(new URL(expandStr(server.url)), { requestInit: { headers: expand(server.headers) } });
    } else if (server.transport === 'sse') {
        transport = new SSEClientTransport(new URL(expandStr(server.url)), { requestInit: { headers: expand(server.headers) } });
    } else {
        throw new Error(`unknown transport ${server.transport}`);
    }
    const client = new Client({ name: 'hasdata-bench', version: '1.0.0' });
    await withTimeout(client.connect(transport), TIMEOUT, 'connect');
    return { client, transport, connectMs: Math.round(performance.now() - t0) };
}

function withTimeout(p, ms, label) {
    let t;
    return Promise.race([
        p.finally(() => clearTimeout(t)),
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms); }),
    ]);
}

// ---------- measure a result ----------
function describe(result) {
    // MCP tool result: { content: [{type:'text', text}], structuredContent?, isError? }
    const texts = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text);
    const raw = texts.join('\n');
    let parsed = result.structuredContent ?? null;
    if (parsed === null) {
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
    }
    // Some servers wrap JSON in prose (Bright Data's "SECURITY NOTICE ... =====UNTRUSTED_x_BEGIN=====", Apify's "Found 15 properties. {...}").
    // Pull the outermost JSON value out of the text so payloads stay comparable.
    if (parsed === null) {
        const start = Math.min(...['{', '['].map((c) => raw.indexOf(c)).filter((i) => i >= 0));
        if (Number.isFinite(start)) {
            const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
            if (end > start) { try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { parsed = null; } }
        }
    }
    // First array of objects anywhere in the value (depth-limited), so nested shapes like {json:{properties:[...]}} count.
    const findItems = (v, depth = 0) => {
        if (depth > 4 || !v || typeof v !== 'object') return null;
        if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? v : null;
        for (const x of Object.values(v)) { const r = findItems(x, depth + 1); if (r) return r; }
        return null;
    };
    const items = findItems(parsed);
    // Error envelopes can live in the text even when structuredContent wraps it differently, so keep the text's own JSON too.
    let textParsed = null;
    try { textParsed = JSON.parse(raw); } catch { textParsed = null; }
    const fieldCount = (o) => (o && typeof o === 'object' ? Object.keys(o).length : 0);
    return {
        isError: !!result.isError,
        bytes: Buffer.byteLength(raw, 'utf8'),
        contentTypes: [...new Set((result.content || []).map((c) => c.type))],
        json: parsed !== null,
        jsonWrappedInProse: parsed !== null && !result.structuredContent && !/^\s*[\[{]/.test(raw),
        topLevelKeys: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 40) : null,
        items: items ? items.length : null,
        fieldsPerItem: items && items.length ? Math.round(items.slice(0, 10).reduce((a, o) => a + fieldCount(o), 0) / Math.min(10, items.length)) : null,
        sample: raw.slice(0, 1500),
        parsed,
        textParsed,
        itemsArray: items,
    };
}

// ---------- commands ----------
async function probe() {
    const dir = outDir('tools');
    for (const server of servers) {
        const out = { id: server.id, target: slug, transport: server.transport, command: server.command, args: server.args, url: server.url, probedAt: new Date().toISOString() };
        let conn;
        try {
            conn = await connect(server);
            out.connectMs = conn.connectMs;
            out.serverInfo = conn.client.getServerVersion?.() ?? null;
            out.capabilities = conn.client.getServerCapabilities?.() ?? null;
            const { tools } = await withTimeout(conn.client.listTools(), TIMEOUT, 'listTools');
            out.toolCount = tools.length;
            out.tools = tools.map((t) => ({
                name: t.name,
                description: t.description,
                descriptionChars: (t.description || '').length,
                required: t.inputSchema?.required || [],
                params: Object.keys(t.inputSchema?.properties || {}),
                paramCount: Object.keys(t.inputSchema?.properties || {}).length,
                hasOutputSchema: !!t.outputSchema,
                inputSchema: t.inputSchema,
            }));
            console.log(`  [ok] ${server.id}: ${tools.length} tools in ${conn.connectMs} ms — ${tools.map((t) => t.name).join(', ')}`);
        } catch (e) {
            out.error = String(e?.message || e);
            out.stderr = server._stderr;
            console.log(`  [FAIL] ${server.id}: ${out.error}`);
        } finally {
            try { await conn?.client.close(); } catch { /* process may already be gone */ }
        }
        fs.writeFileSync(path.join(dir, `${server.id}.json`), JSON.stringify(out, null, 2));
    }
}

async function run() {
    const dir = outDir('results');
    for (const server of servers) {
        const out = { id: server.id, target: slug, transport: server.transport, runs: RUNS, ranAt: new Date().toISOString(), tasks: [] };
        let conn;
        try {
            conn = await connect(server);
            out.connectMs = conn.connectMs;
        } catch (e) {
            out.error = `connect: ${e?.message || e}`;
            out.stderr = server._stderr;
            console.log(`  [FAIL] ${server.id}: ${out.error}`);
            fs.writeFileSync(path.join(dir, `${server.id}.json`), JSON.stringify(out, null, 2));
            continue;
        }
        for (const task of server.tasks || []) {
            const rec = { name: task.name, tool: task.tool, args: task.args, attempts: [] };
            for (let i = 0; i < RUNS; i++) {
                // Repeating one query measures the vendor's cache, not its API: in the 2026-09-15 Google
                // run one server answered call 1 in 40 s and calls 2 and 3 in 77 ms, byte identical.
                // A fixture with "queryVariants" rotates a different query into every run, so each call is cold.
                const variants = fixture.queryVariants;
                const query = Array.isArray(variants) && variants.length ? variants[i % variants.length] : null;
                const args = query ? JSON.parse(JSON.stringify(task.args).replace(/\$Q\b/g, () => query.replace(/["\\]/g, '\\$&'))) : task.args;
                const t0 = performance.now();
                try {
                    // SDK default request timeout is 60 s; pass ours so slow actors are measured, not cut off.
                    let res = await withTimeout(conn.client.callTool({ name: task.tool, arguments: args }, undefined, { timeout: TIMEOUT }), TIMEOUT, task.tool);
                    let d = describe(res);
                    // Apify-style actor MCPs answer with run metadata and expect a second call for the dataset.
                    // task.chain = { tool, args: { datasetId: '$.defaultDatasetId' } } runs it and reports the combined time and the final payload.
                    if (task.chain && !d.isError) {
                        const first = d.parsed;
                        const args = Object.fromEntries(Object.entries(task.chain.args || {}).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('$.') ? v.slice(2).split('.').reduce((o, kk) => (o == null ? o : o[kk]), first) : v]));
                        res = await withTimeout(conn.client.callTool({ name: task.chain.tool, arguments: args }, undefined, { timeout: TIMEOUT }), TIMEOUT, task.chain.tool);
                        d = describe(res);
                        d.chained = true;
                    }
                    const ms = Math.round(performance.now() - t0);
                    // A tool that answers 200 with an error message inside is still a failure for the user.
                    // JSON that is only an error envelope ({"error": ...}, {"message": "quota"}) is a failure too.
                    const isErrObj = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length <= 3 && Object.keys(o).some((k) => /^(error|errors|message|detail)$/i.test(k));
                    const errEnvelope = d.bytes < 2000 && (isErrObj(d.parsed) || isErrObj(d.textParsed));
                    const emptyBody = !res.structuredContent && (d.bytes < 50 || (d.json && d.items === null && d.bytes < 200) || (!d.json && d.bytes < 300)); // empty transcript, bare header, or {results: []} // an empty transcript or a bare header line is not a result
                    // A search result without a link is not a result. One server answers 200 with
                    // [{ title: "Search failed", link: "", snippet: "Unable to complete..." }], which is a
                    // failure dressed as a payload, so check the items themselves rather than the byte count.
                    const linkOf = (o) => { const k = Object.keys(o || {}).find((kk) => /^(link|url|href|permalink)$/i.test(kk)); return k ? o[k] : undefined; };
                    const arr = d.itemsArray;
                    const linkless = Array.isArray(arr) && arr.length > 0 && arr.every((o) => o && typeof o === 'object' && Object.keys(o).some((kk) => /^(link|url|href|permalink|title|name)$/i.test(kk)) && !linkOf(o));
                    const failLabel = /"(?:title|name|message|msg|status)"\s*:\s*"(?:search failed|unable to complete|request failed|no results|error)/i.test(d.sample);
                    // The SDK wraps a plain text body in structuredContent, so d.json is true even when the
                    // payload is prose. nickclyde answered 417 bytes of "No results were found ... DuckDuckGo's
                    // bot detection" and scored as a success until this rule stopped requiring !d.json and
                    // started asking whether any items were found at all.
                    const excuse = /error|failed|exception|unauthori[sz]ed|forbidden|rate limit|captcha|blocked|bot detection|anomaly|no results|no matches|redirect|omdiriger|weiterleit/i;
                    const prosefail = d.items === null && d.bytes < 2000 && excuse.test(d.sample.slice(0, 400));
                    const softFail = d.isError || errEnvelope || emptyBody || linkless || failLabel || prosefail;
                    delete d.parsed;
                    delete d.textParsed;
                    delete d.itemsArray;
                    rec.attempts.push({ ok: !softFail, ms, query, ...d });
                    process.stdout.write(`  ${server.id}/${task.name} #${i + 1}: ${softFail ? 'ERR' : 'ok'} ${ms} ms ${d.bytes} B${d.items != null ? ` ${d.items} items` : ''}\n`);
                } catch (e) {
                    const ms = Math.round(performance.now() - t0);
                    rec.attempts.push({ ok: false, ms, error: String(e?.message || e) });
                    process.stdout.write(`  ${server.id}/${task.name} #${i + 1}: FAIL ${ms} ms ${String(e?.message || e).slice(0, 120)}\n`);
                }
                if (task.pauseMs) await new Promise((r) => setTimeout(r, task.pauseMs));
            }
            const oks = rec.attempts.filter((a) => a.ok);
            const sorted = oks.map((a) => a.ms).sort((a, b) => a - b);
            rec.summary = {
                successRate: oks.length / rec.attempts.length,
                p50Ms: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
                minMs: sorted[0] ?? null,
                maxMs: sorted.at(-1) ?? null,
                medianBytes: oks.length ? oks.map((a) => a.bytes).sort((a, b) => a - b)[Math.floor(oks.length / 2)] : null,
                items: oks.length ? oks[0].items : null,
                fieldsPerItem: oks.length ? oks[0].fieldsPerItem : null,
                json: oks.length ? oks.every((a) => a.json) : null,
            };
            out.tasks.push(rec);
        }
        try { await conn.client.close(); } catch { /* ignore */ }
        out.stderr = server._stderr;
        fs.writeFileSync(path.join(dir, `${server.id}.json`), JSON.stringify(out, null, 2));
    }
}

function report() {
    const toolsDir = path.join(BENCH, 'tools', slug);
    const resDir = path.join(BENCH, 'results', slug);
    // The runs count belongs to the results on disk, not to this invocation's --runs flag,
    // otherwise the report misstates the methodology whoever reads it then quotes.
    const runCounts = new Set();
    let ranAt = null;
    if (fs.existsSync(resDir)) {
        for (const f of fs.readdirSync(resDir).filter((f) => f.endsWith('.json'))) {
            const r = JSON.parse(fs.readFileSync(path.join(resDir, f), 'utf8'));
            for (const t of r.tasks || []) if (t.attempts?.length) runCounts.add(t.attempts.length);
            if (r.ranAt && (!ranAt || r.ranAt > ranAt)) ranAt = r.ranAt;
        }
    }
    const runsLabel = runCounts.size === 1 ? `${[...runCounts][0]}×` : runCounts.size ? `${Math.min(...runCounts)} to ${Math.max(...runCounts)}×` : `${RUNS}×`;
    const variants = Array.isArray(fixture.queryVariants) && fixture.queryVariants.length
        ? ` Each run used a different query (${fixture.queryVariants.map((q) => `\`${q}\``).join(', ')}) so no call is served from a vendor cache.`
        : '';
    const lines = [`# ${slug}: MCP bench`, '', `Generated ${new Date().toISOString().slice(0, 10)}${ranAt ? `, last run ${ranAt.slice(0, 16).replace('T', ' ')} UTC` : ''}. Fixture: \`fixtures/${slug}.json\`. Each task ran ${runsLabel}; p50 over successful calls only.${variants}`, ''];
    lines.push('## Tool surface', '', '| Server | Transport | Connect ms | Tools | Names | Output schema |', '|--|--|--|--|--|--|');
    for (const s of fixture.servers) {
        const p = path.join(toolsDir, `${s.id}.json`);
        if (!fs.existsSync(p)) continue;
        const t = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (t.error) { lines.push(`| ${s.id} | ${s.transport} | — | FAIL | ${t.error.slice(0, 100)} | |`); continue; }
        lines.push(`| ${s.id} | ${s.transport} | ${t.connectMs} | ${t.toolCount} | ${t.tools.map((x) => `\`${x.name}\``).join(', ')} | ${t.tools.filter((x) => x.hasOutputSchema).length}/${t.toolCount} |`);
    }
    lines.push('', '## Task results', '', '| Server | Task | Tool | Success | p50 ms | min–max ms | Median bytes | Items | Fields/item | JSON |', '|--|--|--|--|--|--|--|--|--|--|');
    for (const s of fixture.servers) {
        const p = path.join(resDir, `${s.id}.json`);
        if (!fs.existsSync(p)) continue;
        const r = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (r.error) { lines.push(`| ${s.id} | — | — | FAIL | | | | | | ${r.error.slice(0, 80)} |`); continue; }
        for (const t of r.tasks) {
            const m = t.summary;
            lines.push(`| ${s.id} | ${t.name} | \`${t.tool}\` | ${Math.round(m.successRate * 100)}% | ${m.p50Ms ?? '—'} | ${m.minMs ?? '—'}–${m.maxMs ?? '—'} | ${m.medianBytes ?? '—'} | ${m.items ?? '—'} | ${m.fieldsPerItem ?? '—'} | ${m.json === null ? '—' : m.json ? 'yes' : 'no'} |`);
        }
    }
    lines.push('', '## Failures and errors', '');
    for (const s of fixture.servers) {
        const p = path.join(resDir, `${s.id}.json`);
        if (!fs.existsSync(p)) continue;
        const r = JSON.parse(fs.readFileSync(p, 'utf8'));
        const errs = [];
        if (r.error) errs.push(r.error);
        for (const t of r.tasks || []) for (const a of t.attempts) if (!a.ok) errs.push(`${t.name}: ${(a.error || a.sample || '').replace(/\s+/g, ' ').slice(0, 200)}`);
        if (errs.length) lines.push(`- **${s.id}**`, ...[...new Set(errs)].slice(0, 6).map((e) => `  - ${e}`));
    }
    const out = path.join(BENCH, `report-${slug}.md`);
    fs.writeFileSync(out, lines.join('\n') + '\n');
    console.log(`wrote ${out}`);
}

const ops = { probe, run, report };
if (!ops[cmd]) {
    console.error(`unknown command ${cmd}`);
    process.exit(1);
}
await ops[cmd]();
