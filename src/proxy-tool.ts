import { READ_ORIGINAL_IMAGE_TOOL_NAME, RULE_TOOL_NAME, PROXY_TOOL_NAMES } from "./compress-tool.js";
import { ccrEnabled, retrieveToolName } from "./store.js";
import { effectiveRulesEnabled } from "./rules-feature.js";
import type { Config } from "acp-kernel";
import type { Session } from "./session.js";

export function isProxyToolFor(name: string, session: Session | undefined, config: Config): boolean {
    if (PROXY_TOOL_NAMES.has(name)) return true;
    // #3400: read_original_image executes server-side on EVERY lane — even
    // where it is not registered in the manifest (codex) a hallucinated call
    // must never reach the client as an unsupported tool.
    if (name === READ_ORIGINAL_IMAGE_TOOL_NAME) return true;
    if (ccrEnabled(session) && name === retrieveToolName(session)) return true;
    return effectiveRulesEnabled(session, config) && name === RULE_TOOL_NAME;
}
