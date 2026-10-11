// #2733 investigation: RE-FOLD seam on the Responses wire (codex path).
// Production signature (v0.1.188-192, /tmp/2733-full-log.txt): after a fold whose
// range nests over a PRIOR fold's covered region, the very next request matches only
// the immutable head (~11.1K / ~13.7K tokens) instead of head+anchor — i.e. the
// provider's longest-prefix dies at the FIRST summary item, not at the new fold's
// start. Hypothesis: block consumption (compress.ts: directBlockIds=consumedBlockIds)
// merges the consumed block's coverage into the new block, and collectSummaryAnchors
// (prune.ts) anchors the merged summary at the EARLIEST effective message — which can
// sit far before the new fold's startRef — so the new summary bytes REPLACE the old
// summary bytes at that early anchor and the prefix match collapses to the head.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

type Item = Record<string, unknown>;

const SUMMARY_MARKER = "[Compressed conversation section]";
const FOLD1_AT = 6; // upstream request index whose response = first compress call (3 ranges)
const FOLD2_AT = 12; // upstream request index whose response = re-fold compress call (3 ranges over the same region)
const TOTAL_TURNS = 18;

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the build pipeline ran cleanly and the integration suite reported no regressions across all four regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

function sseBlock(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function textSse(res: http.ServerResponse, id: string, text: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sseBlock("response.created", { response: { id, status: "in_progress" } }));
    res.write(sseBlock("response.output_item.added", { output_index: 0, item: { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] } }));
    res.write(sseBlock("response.output_text.delta", { item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: text }));
    res.write(sseBlock("response.output_text.done", { item_id: `msg_${id}`, output_index: 0, content_index: 0, text }));
    res.write(sseBlock("response.output_item.done", { output_index: 0, item: { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] } }));
    res.write(sseBlock("response.completed", { response: { id, status: "completed", output: [{ type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] } }));
    res.end();
}

function compressCallSse(res: http.ServerResponse, id: string, args: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sseBlock("response.created", { response: { id, status: "in_progress" } }));
    res.write(sseBlock("response.output_item.added", { output_index: 0, item: { type: "function_call", id: `fc_${id}`, call_id: `call_cmp_${id}`, name: "compress", arguments: "", status: "in_progress" } }));
    res.write(sseBlock("response.function_call_arguments.delta", { item_id: `fc_${id}`, output_index: 0, delta: args }));
    res.write(sseBlock("response.function_call_arguments.done", { item_id: `fc_${id}`, output_index: 0, arguments: args }));
    res.write(sseBlock("response.output_item.done", { output_index: 0, item: { type: "function_call", id: `fc_${id}`, call_id: `call_cmp_${id}`, name: "compress", arguments: args, status: "completed" } }));
    res.write(sseBlock("response.completed", { response: { id, status: "completed", output: [{ type: "function_call", id: `fc_${id}`, call_id: `call_cmp_${id}`, name: "compress", arguments: args, status: "completed" }] } }));
    res.end();
}

const INSTRUCTIONS = ["You are a coding agent operating in a sandbox.", "Follow repo conventions strictly.", "Run tests before finishing.", "Environment notes: linux, node 22, repo at /workspace."].join("\n") + "\n\n" + FILLER(999, 1);

const refsOf = (items: Item[]): string[] => {
    const refs: string[] = [];
    for (const it of items) {
        const s = JSON.stringify(it);
        for (const m of s.matchAll(/\x3cacp [^>]*>(m\d+)\x3c\/acp>/g)) refs.push(m[1]!);
    }
    return [...new Set(refs)];
};

const summaryIndices = (items: Item[]): number[] =>
    items.map((it, i) => (it.type === "message" && typeof it.content === "string" && (it.content as string).includes(SUMMARY_MARKER) ? i : -1)).filter((i) => i >= 0);

const firstDivergence = (a: Item[], b: Item[]): number => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
    return n;
};

const rmrf = (p: string): void => { fs.rmSync(p, { recursive: true, force: true }); };

test("#2733: re-fold over a prior fold re-anchors the merged summary at the consumed block's early anchor", { timeout: 120_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refold-seam-"));
    process.env.XDG_STATE_HOME = tmp;
    delete process.env.ACP_DUMP_BODY;

    let proxy: http.Server | undefined;
    let upstream: http.Server | undefined;

    const closeServer = (s: http.Server | undefined): Promise<void> => s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();

    try {
        const captured: Array<{ url: string; body: string }> = [];
        const f1refs: string[] = [];
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const idx = captured.length;
                const body = Buffer.concat(chunks).toString("utf8");
                captured.push({ url: req.url ?? "", body });
                if (idx === FOLD1_AT) {
                    const prev = (JSON.parse(captured[idx - 1]!.body) as { input?: Item[] }).input ?? [];
                    const uniq = refsOf(prev);
                    f1refs.push(...uniq);
                    assert.ok(uniq.length >= 11, `fold1: expected >=11 tagged refs, saw ${uniq.length}`);
                    const args = JSON.stringify({ content: [
                        { startId: uniq[3]!, endId: uniq[5]!, topic: "F1A", summary: `F1A summary: ${FILLER(1, 1)}` },
                        { startId: uniq[6]!, endId: uniq[8]!, topic: "F1B", summary: `F1B summary: ${FILLER(2, 1)}` },
                    ] });
                    compressCallSse(res, `resp_${idx}`, args);
                    return;
                }
                if (idx === FOLD2_AT) {
                    const prev = (JSON.parse(captured[idx - 1]!.body) as { input?: Item[] }).input ?? [];
                    const uniq = refsOf(prev);
                    assert.ok(uniq.length >= 13, `fold2: expected >=13 tagged refs, saw ${uniq.length}`);
                    // re-fold: start INSIDE F1A's covered span (mid of f1refs[3..5]) and end past fold-1's
                    // end → the new block consumes b1/b2, merging their effective ids back to F1A's start.
                    const args = JSON.stringify({ content: [
                        { startId: "m00001", endId: uniq[9]!, topic: "F2A", summary: `F2A summary: ${FILLER(4, 1)}` },
                    ] });
                    compressCallSse(res, `resp_${idx}`, args);
                    return;
                }
                const parsed = JSON.parse(body) as { input?: Item[] };
                let label = "0";
                for (let i = (parsed.input ?? []).length - 1; i >= 0; i--) {
                    const it = parsed.input![i]!;
                    if (it.type === "message" && it.role === "user" && typeof it.content === "string") {
                        const m = (it.content as string).match(/Turn (\d+):/);
                        if (m) { label = m[1]!; break; }
                    }
                }
                textSse(res, `resp_${idx}`, `Reply Turn ${label}: done. ` + FILLER(Number(label), 0.2));
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;

        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 200_000 } } } },
            modelContextLimit: 200_000,
            kernelConfig: defaultConfig(200_000),
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: true,
            debug: false,
            passthrough: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        streamErrorShape: "protocol",
        passthroughSource: null,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;

        const input: Item[] = [];
        for (let t = 0; t < TOTAL_TURNS; t++) {
            const userText = `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6);
            const userMsg: Item = { type: "message", role: "user", content: userText };
            const body = {
                model: "gpt-test",
                stream: true,
                instructions: INSTRUCTIONS,
                tools: [{ type: "function", name: "shell", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
                input: [...input, userMsg],
            };
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "refold-seam-test" }, body: JSON.stringify(body) });
            if (!res.ok) {
                const errBody = await res.text().catch(() => "");
                throw new Error(`turn ${t} failed HTTP ${res.status}: ${errBody.slice(0, 300)}`);
            }
            await res.text();
            input.push(userMsg);
            input.push({ type: "reasoning", id: `rs_${t}`, encrypted_content: `enc_${t}_` + "x".repeat(200) });
            const replyText = `Reply Turn ${t}: done. ` + FILLER(t, 0.2);
            input.push({ type: "message", id: `msg_a${t}`, role: "assistant", content: replyText });
            if (t % 2 === 0) {
                input.push({ type: "function_call", id: `fc_t${t}`, call_id: `call_t${t}`, name: "shell", arguments: JSON.stringify({ command: `ls -la mod-${t}` }), status: "completed" });
                input.push({ type: "function_call_output", id: `fco_t${t}`, call_id: `call_t${t}`, output: `total 8\ndrwxr-xr-x 2 u g 4096 Sep 27 10:00 .\n-rw-r--r-- 1 u g  42 Sep 27 10:00 file-${t}.ts` });
            }
        }

        const inputs = captured.map((c) => (JSON.parse(c.body) as { input?: Item[] }).input ?? []);
        assert.ok(inputs.length >= FOLD2_AT + 3, `expected >= ${FOLD2_AT + 3} upstream requests, got ${inputs.length}`);

        // ---- fold 1 sanity (#1548 invariants must still hold) ----
        const f1r2 = inputs[FOLD1_AT + 1]!;
        const f1Pre = inputs[FOLD1_AT - 1]!;
        const f1SumIdx = summaryIndices(f1r2);
        assert.ok(f1SumIdx.length >= 1, "fold-1 round-2 must carry the in-place summary");
        const next1 = inputs[FOLD1_AT + 2]!;
        const s1 = summaryIndices(next1);
        assert.ok(s1.length >= 1 && s1[0] === f1SumIdx[0], "fold-1: summary anchor position drifts into next turn");
        for (let i = 0; i <= s1[0]!; i++) {
            assert.equal(JSON.stringify(next1[i]), JSON.stringify(inputs[FOLD1_AT + 1]![i]), `fold-1 growth: item[${i}] diverges`);
        }
        console.log(`fold-1: summary anchored at item[${f1SumIdx[0]}]; pre-fold body had ${summaryIndices(f1Pre).length} summaries`);

        // ---- fold 2: the re-fold ----
        const f2Pre = inputs[FOLD2_AT - 1]!; // last body the provider cached before the re-fold
        const f2r2 = inputs[FOLD2_AT + 1]!; // post-fold re-request (refreshed view)
        const f2Next = inputs[FOLD2_AT + 2]!; // next steady client turn

        const preSums = summaryIndices(f2Pre);
        const r2Sums = summaryIndices(f2r2);
        const nextSums = summaryIndices(f2Next);
        console.log(`re-fold: pre summaries at [${preSums}], post-fold-r2 at [${r2Sums}], next steady at [${nextSums}]`);

        const div = firstDivergence(f2Pre, f2r2);
        const nPre = f2Pre.length;
        console.log(`re-fold: first divergence between provider-cached body and post-fold body at item[${div}] of ${nPre}`);
        console.log(`re-fold: divergence item pre=${JSON.stringify(f2Pre[div])?.slice(0, 140)}`);
        console.log(`re-fold: divergence item post=${JSON.stringify(f2r2[div])?.slice(0, 140)}`);

        // Where the NEW summary should have anchored: at the first RETAINED message
        // after the new range start (i.e. near the end of the folded span). Where it
        // actually anchored:
        const newSumIdx = r2Sums[0] ?? -1;
        const early = preSums[0] ?? -1;
        console.log(`re-fold: new summary anchored at item[${newSumIdx}]; prior block's anchor was item[${early}]`);

        // THE BUG ASSERTIONS (soft for now — diagnostics first, pin after confirmation)
        if (newSumIdx >= 0 && early >= 0 && newSumIdx <= early) {
            console.log("BUG CONFIRMED: merged summary re-anchored at/behind the consumed block's early anchor — prefix cache collapses to the head");
        } else {
            console.log("NOTE: merged summary did NOT re-anchor early — hypothesis needs revision");
        }
        if (div < (preSums[0] ?? Number.POSITIVE_INFINITY)) {
            console.log("NOTE: divergence begins BEFORE the first prior summary — something even earlier mutated");
        }

        // ---- hit-2 analysis: r2 (loop-refreshed view) vs next steady turn ----
        const div2 = firstDivergence(f2r2, f2Next);
        console.log(`hit2: first divergence between post-fold r2 and next steady at item[${div2}] (r2 len ${f2r2.length}, steady len ${f2Next.length})`);
        for (const i of [div2 - 1, div2, div2 + 1].filter((x) => x >= 0)) {
            console.log(`hit2: r2[${i}]     =${JSON.stringify(f2r2[i])?.slice(0, 1400)}`);
            console.log(`hit2: steady[${i}] =${JSON.stringify(f2Next[i])?.slice(0, 180)}`);
        }
        for (const [lbl, view] of [["f2Pre", f2Pre], ["f2r2", f2r2], ["f2Next", f2Next]] as const) {
            console.log(`VIEW ${lbl}:`);
            view.slice(0, 12).forEach((it, i) => {
                const js = JSON.stringify(it) ?? "";
                const short = it.type === "message" && typeof it.content === "string"
                    ? (it.content.startsWith(SUMMARY_MARKER) ? "SUMMARY:" + it.content.slice(30, 80) : (it.content.match(/(m\d+)/)?.[1] ?? "?") + " " + it.content.slice(0, 40))
                    : js.slice(0, 60);
                console.log(`  ${lbl}[${i}] ${it.type} ${short.replace(/\n/g, "|")}`);
            });
        }
        const sharedThroughAnchor = newSumIdx >= 0 && nextSums[0] === newSumIdx
            && JSON.stringify(f2r2[newSumIdx]) === JSON.stringify(f2Next[nextSums[0]!]);
        console.log(`hit2: steady shares r2's bytes through the anchor item: ${sharedThroughAnchor}`);
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        rmrf(tmp);
    }
});
