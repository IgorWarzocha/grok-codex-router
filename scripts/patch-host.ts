#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const START = "/* GROK_CODEX_ROUTER_SESSION_START */";
const END = "/* GROK_CODEX_ROUTER_SESSION_END */";
const SERVICE_START = "/* GROK_CODEX_ROUTER_SERVICE_START */";
const SERVICE_END = "/* GROK_CODEX_ROUTER_SERVICE_END */";
const hostDir = process.env.SAND_HOST_DIR || path.join(os.homedir(), "sand-host");
const hostFile = path.join(hostDir, "host-main.cjs");
const backupFile = path.join(hostDir, "host-main.cjs.grok-codex-router-bak");
const routerEntry = path.resolve(__dirname, "..", "src", "session.js");
const checkOnly = process.argv.includes("--check");

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function fail(message: string): never {
  console.error("ERROR: " + message);
  process.exit(1);
}

if (!fs.existsSync(hostFile)) fail("missing " + hostFile);
if (!fs.existsSync(routerEntry)) fail("missing compiled router entry " + routerEntry);
const originalSource = fs.readFileSync(hostFile, "utf8");
let source = originalSource;
let backupSource = originalSource;
if ((source.includes(SERVICE_START) || source.includes(START)) && !fs.existsSync(backupFile)) {
  fail("router hook exists but its pristine host backup is missing");
}

const firstLineEnd = source.indexOf("\n");
if (firstLineEnd < 0 || !source.startsWith("const __mod=require('node:module');")) {
  fail("unfamiliar Sand host bundle prelude");
}
const serviceHook = [
  SERVICE_START,
  "try {",
  '  const __grokCodexRouterHome = process.env.SAND_CODEX_ROUTER_HOME || require("path").join(require("os").homedir(), "grok-codex-router");',
  "  require(__grokCodexRouterHome).ensureControlService();",
  "} catch (__grokCodexRouterServiceError) {",
  '  console.error("[grok-codex-router] control service start failed: " + String(__grokCodexRouterServiceError && __grokCodexRouterServiceError.message || __grokCodexRouterServiceError));',
  "}",
  SERVICE_END
].join("\n");
const serviceInstalled = source.includes(SERVICE_START);
if (!serviceInstalled) {
  if (source.slice(firstLineEnd + 1, firstLineEnd + 14) !== '"use strict";') {
    fail("unfamiliar Sand host bundle prelude");
  }
} else if (!source.slice(firstLineEnd + 1).startsWith(serviceHook + '\n"use strict";')) {
  fail("installed control service hook has an unfamiliar shape");
}

const oldHookStart = '      const inferenceProvider = (process.env.SAND_INFERENCE_PROVIDER || "xai").toLowerCase();';
const cursorAnchor = "      const session = createCursorInferencePromptSession({";
const routerHook = [
  "      " + START,
  '      const inferenceProvider = (process.env.SAND_INFERENCE_PROVIDER || "codex-router").toLowerCase();',
  '      if (inferenceProvider !== "cursor") {',
  '        const routerHome = process.env.SAND_CODEX_ROUTER_HOME || require("path").join(require("os").homedir(), "grok-codex-router");',
  '        const { createCodexRouterSession } = require(routerHome);',
  "        return createCodexRouterSession({",
  "          requestedModel,",
  "          onRequestId,",
  "          sessionOptions",
  "        });",
  "      }",
  "      " + END
].join("\n");

if (!source.includes(START)) {
  if (source.includes(oldHookStart)) {
    const start = source.indexOf(oldHookStart);
    const end = source.indexOf(cursorAnchor, start);
    if (end < 0 || source.indexOf(oldHookStart, start + 1) >= 0) {
      fail("could not isolate the legacy custom-inference hook");
    }
    backupSource = source.slice(0, start) + source.slice(end);
    source = source.slice(0, start) + routerHook + "\n" + source.slice(end);
  } else {
    if (count(source, cursorAnchor) !== 1) fail("expected one Cursor session anchor");
    source = source.replace(cursorAnchor, routerHook + "\n" + cursorAnchor);
  }
}

if (!serviceInstalled) {
  source = source.slice(0, firstLineEnd + 1) + serviceHook + "\n" + source.slice(firstLineEnd + 1);
}

const mainAnchor = [
  "        const mainSessionOptions = {",
  "          modelId: host.subagentModelId,"
].join("\n");
const mainIdentity = [
  "        const mainSessionOptions = {",
  "          conversationId,",
  "          transcriptId: host.getTranscriptId(),",
  "          isGroupMemberTurn: options2.isGroupMemberTurn === true,",
  "          modelId: host.subagentModelId,"
].join("\n");
if (!source.includes(mainIdentity)) {
  if (count(source, mainAnchor) !== 1) fail("expected one main session-options anchor");
  source = source.replace(mainAnchor, mainIdentity);
}

const summaryOwner = "        const summarizationSession = sanitizePromptSessionUsage(";
if (count(source, summaryOwner) !== 1) fail("expected one turn summarization session");
const summaryBoundary = "        const turnStartedAtMs = Date.now();";
if (count(source, summaryBoundary) !== 1) fail("expected one turn summarization boundary");
const summaryStart = source.indexOf(summaryOwner);
const summaryEnd = source.indexOf(summaryBoundary, summaryStart);
if (summaryEnd < 0) fail("turn summarization boundary precedes its session");
let summary = source.slice(summaryStart, summaryEnd);
const summaryAnchor = [
  "            {",
  "              modelId: SAND_SUMMARIZATION_MODEL_ID,"
].join("\n");
const summaryIdentity = [
  "            {",
  "              conversationId,",
  "              transcriptId: host.getTranscriptId(),",
  "              modelId: SAND_SUMMARIZATION_MODEL_ID,"
].join("\n");
if (!summary.includes(summaryIdentity)) {
  if (count(summary, summaryAnchor) !== 1) fail("expected one turn summarization options anchor");
  summary = summary.replace(summaryAnchor, summaryIdentity);
  source = source.slice(0, summaryStart) + summary + source.slice(summaryEnd);
}

if (count(source, SERVICE_START) !== 1 || count(source, SERVICE_END) !== 1) fail("service hook markers are not unique");
if (count(source, START) !== 1 || count(source, END) !== 1) fail("router hook markers are not unique");
if (count(source, "          conversationId,") < 2) fail("conversation identity propagation is incomplete");
if (checkOnly) {
  console.log("host patch is compatible: " + hostFile);
  process.exit(0);
}
if (!fs.existsSync(backupFile)) {
  fs.writeFileSync(backupFile, backupSource, { flag: "wx" });
} else if (!originalSource.includes(START) && fs.readFileSync(backupFile, "utf8") !== backupSource) {
  const prior = fs.readFileSync(backupFile);
  const archive = backupFile + "." + crypto.createHash("sha256").update(prior).digest("hex").slice(0, 12);
  if (!fs.existsSync(archive)) fs.renameSync(backupFile, archive);
  else fs.unlinkSync(backupFile);
  fs.writeFileSync(backupFile, backupSource, { flag: "wx" });
}
fs.writeFileSync(hostFile, source);
console.log("installed Grok Codex Router hook in " + hostFile);
