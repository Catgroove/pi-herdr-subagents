/**
 * Extension loaded into every subagent child pi (via `-e <this file>`).
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 * - Provides a `caller_ping` tool to ask the parent orchestrator for help
 *
 * Ported from pi-interactive-subagents (MIT, HazAT)
 * pi-extension/subagents/subagent-done.ts @ fix/launch-verify-retry, with the
 * activity recorder stripped (stall detection is discarded in this design —
 * herdr's pane.exited gives truthful lifecycle instead).
 *
 * The `.exit` sidecar written here is a cross-extension contract: the
 * orchestrator's watcher (src/watcher.ts) classifies completion from exactly
 * these shapes — {"type":"done"}, {"type":"error","message":...} and
 * {"type":"ping","name":...,"message":...}.
 * Keep this file dependency-light: it loads into EVERY child.
 */
import type { ContextUsage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";

import { writeContextUsageSidecar } from "./src/context-usage.ts";
import { getActiveSubagentCount } from "./src/runtime-state.ts";

/**
 * Decide how an auto-exit subagent ends once pi has settled a run, meaning no
 * automatic retry, compaction, or queued continuation will follow. Returns
 * null to keep the session open.
 *
 * `messages` are those of the run's last agent_end, undefined when the run
 * ended before any. A run that settles on an error (a provider refusal, or a
 * transient failure that exhausted pi's retries) or without a reply exits as
 * an error, so the orchestrator hears about it instead of waiting on an idle
 * pane forever.
 */
export function settledExit(
  aborted: boolean,
  messages: any[] | undefined,
  activeSubagentCount = 0,
): ExitSidecarData | null {
  // Escape leaves the session open for inspection or another prompt.
  if (aborted) return null;

  // A subagent can itself act as an orchestrator. Exiting its pi process here
  // would abort the nested watchers, so their eventual results would have no
  // live session to steer. Keep it open until every nested child has settled.
  if (activeSubagentCount > 0) return null;

  const last = messages?.[messages.length - 1];
  if (last?.role !== "assistant") {
    return { type: "error", message: "The run ended without an assistant reply." };
  }
  if (last.stopReason === "error") {
    return { type: "error", message: last.errorMessage || "The run ended with an unknown error." };
  }
  return { type: "done" };
}

export type ExitSidecarData =
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "ping"; name: string; message: string };

/**
 * Write the completion sidecar the orchestrator's watcher classifies from.
 * Byte-shape must match pi-interactive-subagents exactly (key order included):
 *   {"type":"done"}
 *   {"type":"ping","name":"...","message":"..."}
 * plus this package's own {"type":"error","message":"..."}.
 */
export function writeExitSidecar(sessionFile: string, data: ExitSidecarData): void {
  const payload =
    data.type === "done"
      ? { type: "done" as const }
      : data.type === "error"
        ? { type: "error" as const, message: data.message }
        : { type: "ping" as const, name: data.name, message: data.message };
  writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
}

export default function (pi: ExtensionAPI) {
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";

  let lastRunMessages: any[] | undefined;
  let contextUsageWritten = false;
  let terminalSidecarWritten = false;

  function signalTerminalSidecar(data: ExitSidecarData): void {
    if (terminalSidecarWritten) return;
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (!sessionFile) return;
    writeExitSidecar(sessionFile, data);
    terminalSidecarWritten = true;
  }

  function snapshotContextUsage(
    ctx: { getContextUsage?: () => ContextUsage | null | undefined },
    fallback = false,
  ): void {
    if (contextUsageWritten) return;

    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    const id = process.env.PI_SUBAGENT_ID;
    if (!sessionFile || !id) return;

    let usage: ContextUsage | null | undefined;
    try {
      usage = ctx.getContextUsage?.();
    } catch {
      return;
    }
    if (usage == null) return;

    try {
      contextUsageWritten = writeContextUsageSidecar(sessionFile, id, usage, {
        overwrite: !fallback,
      });
    } catch {
      // Telemetry is best-effort and must never prevent terminal signaling.
    }
  }

  pi.on("agent_start", () => {
    lastRunMessages = undefined;
  });

  pi.on("agent_end", (event) => {
    lastRunMessages = event.messages;
  });

  // Decide on agent_settled, not agent_end: agent_end also fires before each
  // automatic retry, while agent_settled fires once pi will do nothing more.
  pi.on("agent_settled", (event, ctx) => {
    if (!autoExit) return;
    const exit = settledExit(event.aborted, lastRunMessages, getActiveSubagentCount());
    if (!exit) return;

    // Write the .exit sidecar so the watcher classifies this as a proper
    // completion, not a user close. Most models finish and stop talking
    // without explicitly calling subagent_done — a clean auto-exit IS a
    // completion.
    snapshotContextUsage(ctx);
    signalTerminalSidecar(exit);
    ctx.shutdown();
  });

  // User-driven exits do not pass through a terminal tool or clean agent_end.
  // Do not overwrite a snapshot already published by another terminal path.
  pi.on("session_shutdown", (_event, ctx) => {
    snapshotContextUsage(ctx, true);
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      snapshotContextUsage(ctx);
      signalTerminalSidecar({
        type: "ping",
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      });

      ctx.shutdown();
      return {
        content: [
          { type: "text", text: "Ping sent. Session will exit and parent will be notified." },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) {
        snapshotContextUsage(ctx);
        signalTerminalSidecar({ type: "done" });
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
